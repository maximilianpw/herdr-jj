import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type Commands, PluginError, parse, parseJson } from "./command";

const workspaceSchema = z.object({
  name: z.string().min(1),
  path: z.string().nullable(),
  commitId: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type JjWorkspace = z.infer<typeof workspaceSchema>;

const statusSchema = z.object({
  changeId: z.string(),
  commitId: z.string().regex(/^[a-f0-9]{40,64}$/),
  bookmarks: z.array(z.string()),
  conflict: z.boolean(),
  files: z.number().int().nonnegative(),
});
export type JjStatus = z.infer<typeof statusSchema>;

export function containsPath(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return (
    diff === "" ||
    (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff))
  );
}

export function workspaceName(input: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input)) {
    throw new PluginError(
      "invalid_input",
      "Invalid workspace name. Use 1–64 letters, digits, hyphens or underscores, starting with a letter or digit.",
    );
  }
  return input;
}

export class Repository {
  private constructor(
    readonly root: string,
    readonly primary: string,
    readonly commonGitDir: string,
    readonly commands: Commands,
  ) {}

  static load(cwd: string, commands: Commands): Repository {
    let root: string;
    try {
      root = realpathSync(commands.jj(cwd, ["root"]).trim());
    } catch (cause) {
      throw new PluginError(
        "not_jj",
        "No usable jj workspace at the target. For a Git-only repository, explicitly opt in with `jj git init --colocate` there; opening never converts it.",
        { cause },
      );
    }
    if (!existsSync(join(root, ".git"))) {
      throw new PluginError(
        "not_colocated",
        "Workspace is not colocated. Explicitly run `jj git colocation enable` there before using this plugin.",
      );
    }
    const commonGitDir = realpathSync(
      commands
        .git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .trim(),
    );
    const jjGitDir = realpathSync(commands.jj(root, ["git", "root"]).trim());
    if (jjGitDir !== commonGitDir) {
      throw new PluginError(
        "not_colocated",
        "Git and jj do not share a supported primary repository. Reconcile colocation before retrying.",
      );
    }
    // Linked JJ workspaces point to the primary .jj/repo. Git's common
    // directory can instead live in a superproject's .git/modules directory.
    const repoEntry = join(root, ".jj", "repo");
    let jjRepoDir: string;
    try {
      jjRepoDir = realpathSync(
        lstatSync(repoEntry).isFile()
          ? resolve(dirname(repoEntry), readFileSync(repoEntry, "utf8").trim())
          : repoEntry,
      );
      if (!lstatSync(jjRepoDir).isDirectory()) {
        throw new Error("JJ repository path is not a directory");
      }
    } catch (cause) {
      throw new PluginError(
        "not_colocated",
        "Cannot resolve the primary jj repository. Reconcile its workspace metadata before retrying.",
        { cause },
      );
    }
    const primary = dirname(dirname(jjRepoDir));
    if (
      jjRepoDir !== join(primary, ".jj", "repo") ||
      realpathSync(commands.jj(primary, ["root"]).trim()) !== primary ||
      realpathSync(commands.jj(primary, ["git", "root"]).trim()) !==
        commonGitDir ||
      realpathSync(
        commands.git(primary, ["rev-parse", "--show-toplevel"]).trim(),
      ) !== primary ||
      realpathSync(
        commands.git(primary, ["rev-parse", "--absolute-git-dir"]).trim(),
      ) !== commonGitDir
    ) {
      throw new PluginError(
        "not_colocated",
        "Primary jj workspace and Git checkout do not share the same repository. Reconcile colocation before retrying.",
      );
    }
    return new Repository(root, primary, commonGitDir, commands);
  }

  list(): JjWorkspace[] {
    const output = this.commands.jj(this.root, [
      "workspace",
      "list",
      "-T",
      'json({"name" => name, "path" => root, "commitId" => target.commit_id()}) ++ "\n"',
    ]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => parse(workspaceSchema, parseJson(line), "jj workspace"));
  }

  workspace(name: string): JjWorkspace & { path: string } {
    const workspaces = this.list();
    const workspace = workspaces.find((item) => item.name === name);
    if (!workspace?.path) {
      throw new PluginError(
        "state_conflict",
        "Workspace is missing or has no recorded path. Use `jj workspace list` to reconcile it.",
      );
    }
    const path = realpathSync(workspace.path);
    if (path !== resolve(workspace.path)) {
      throw new PluginError(
        "state_conflict",
        "Workspace path contains a symbolic link. Reconcile the recorded path before proceeding.",
      );
    }
    const target = Repository.load(path, this.commands);
    const currentName = this.commands
      .jj(path, [
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        'working_copies.map(|w| w.name()).join("\n")',
      ])
      .trim()
      .split("\n");
    if (
      target.root !== path ||
      target.commonGitDir !== this.commonGitDir ||
      target.primary !== this.primary ||
      (workspaces.length > 1 && !currentName.includes(name)) ||
      target.status().commitId !== workspace.commitId
    ) {
      throw new PluginError(
        "state_conflict",
        "Workspace identity no longer matches its recorded path. Reconcile it before proceeding.",
      );
    }
    return { ...workspace, path };
  }

  status(path = this.root): JjStatus {
    return parse(
      statusSchema,
      parseJson(
        this.commands.jj(path, [
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          'json({"changeId" => change_id.short(8), "commitId" => commit_id, "bookmarks" => bookmarks.map(|b| b.name()), "conflict" => conflict, "files" => diff.files().len()})',
        ]),
      ),
      "jj status",
    );
  }

  snapshot(path = this.root): void {
    this.commands.jj(path, ["status"], true);
  }

  resolveBase(base: "trunk" | "current"): string {
    // Continuation means a NEW child of @, never concurrent editing of one change.
    return this.commands
      .jj(
        this.root,
        [
          "log",
          "-r",
          base === "trunk" ? "trunk()" : "@",
          "--no-graph",
          "-T",
          "commit_id",
        ],
        base === "current",
      )
      .trim();
  }

  ignoredFiles(path: string): string[] {
    return this.commands
      .git(path, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
      .split("\0")
      .filter((name) => name && name !== ".jj" && !name.startsWith(".jj/"));
  }

  untrackedFiles(path: string): string[] {
    return this.commands
      .git(path, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter((name) => name && name !== ".jj" && !name.startsWith(".jj/"));
  }
}
