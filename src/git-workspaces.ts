import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type Commands, PluginError, parse } from "./command";
import { workspaceName } from "./repository";
import type { PluginState } from "./state";

const gitWorkspaceSchema = z.object({
  kind: z.literal("git"),
  name: z.string().min(1),
  path: z.string().min(1),
  commitId: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string().optional(),
});
export type GitWorkspace = z.infer<typeof gitWorkspaceSchema>;

const gitCreationSchema = z.object({
  name: z.string(),
  path: z.string(),
  source: z.string(),
  base: z.string(),
  parent: z.string(),
  phase: z.enum(["creating", "ready"]),
});

export class GitWorkspaces {
  private constructor(
    readonly root: string,
    readonly primary: string,
    readonly commonGitDir: string,
    private readonly commands: Commands,
  ) {}

  static load(cwd: string, commands: Commands): GitWorkspaces {
    const root = realpathSync(
      commands.git(cwd, ["rev-parse", "--show-toplevel"]).trim(),
    );
    const commonGitDir = realpathSync(
      commands
        .git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .trim(),
    );
    const gitDir = realpathSync(
      commands.git(root, ["rev-parse", "--absolute-git-dir"]).trim(),
    );
    let primary = root;
    if (gitDir !== commonGitDir) {
      const configured = commands.run(
        "git",
        ["--git-dir", commonGitDir, "config", "--get", "core.worktree"],
        root,
      );
      if (
        configured.error ||
        (configured.status !== 0 && configured.status !== 1)
      ) {
        throw new PluginError(
          "command_failed",
          "Cannot resolve the primary Git checkout.",
          { cause: configured.error ?? new Error(configured.stderr) },
        );
      }
      if (configured.status === 0) {
        primary = realpathSync(resolve(commonGitDir, configured.stdout.trim()));
      } else {
        const first = commands
          .git(root, ["worktree", "list", "--porcelain", "-z"])
          .split("\0")[0];
        if (!first?.startsWith("worktree ")) {
          throw new PluginError(
            "invalid_response",
            "Git worktree list has no primary checkout.",
          );
        }
        primary = realpathSync(first.slice("worktree ".length));
      }
    }
    if (
      realpathSync(
        commands.git(primary, ["rev-parse", "--show-toplevel"]).trim(),
      ) !== primary ||
      realpathSync(
        commands.git(primary, ["rev-parse", "--absolute-git-dir"]).trim(),
      ) !== commonGitDir
    ) {
      throw new PluginError(
        "state_conflict",
        "Primary Git checkout does not match the shared repository. Reconcile it before retrying.",
      );
    }
    return new GitWorkspaces(root, primary, commonGitDir, commands);
  }

  list(): GitWorkspace[] {
    return this.commands
      .git(this.root, ["worktree", "list", "--porcelain", "-z"])
      .split("\0\0")
      .filter(Boolean)
      .map((record) => {
        const fields = record.split("\0");
        const recordedPath = fields
          .find((field) => field.startsWith("worktree "))
          ?.slice(9);
        // Git reports the administrative directory as the primary worktree for
        // absorbed submodules; use the checkout identity verified by load().
        const path =
          recordedPath === this.commonGitDir ? this.primary : recordedPath;
        const branch = fields
          .find((field) => field.startsWith("branch refs/heads/"))
          ?.slice(18);
        return parse(
          gitWorkspaceSchema,
          {
            kind: "git",
            path,
            branch,
            name: branch ?? (path ? basename(path) : undefined),
            commitId: fields
              .find((field) => field.startsWith("HEAD "))
              ?.slice(5),
          },
          "Git workspace",
        );
      });
  }

  workspace(path: string): GitWorkspace {
    const workspace = this.list().find((entry) => entry.path === path);
    if (
      !workspace ||
      !existsSync(path) ||
      realpathSync(path) !== resolve(path)
    ) {
      throw new PluginError(
        "state_conflict",
        "Git workspace path is missing or substituted. Reconcile the checkout before opening it.",
      );
    }
    const target = GitWorkspaces.load(path, this.commands);
    if (
      target.root !== path ||
      target.commonGitDir !== this.commonGitDir ||
      target.primary !== this.primary
    ) {
      throw new PluginError(
        "state_conflict",
        "Git workspace does not belong to the selected repository.",
      );
    }
    return workspace;
  }

  create(nameInput: string, base: string, state: PluginState): GitWorkspace {
    const name = workspaceName(nameInput);
    const path = join(
      dirname(this.primary),
      `${basename(this.primary)}.git-${name}`,
    );
    return state.withLock(() => {
      let receipt = state.read(`git-create-${name}`, gitCreationSchema);
      if (
        receipt &&
        (receipt.path !== path ||
          receipt.source !== this.root ||
          receipt.base !== base)
      ) {
        throw new PluginError(
          "state_conflict",
          "Git workspace creation retry does not match its saved request. Use the original request or open the existing workspace.",
        );
      }
      if (!receipt) {
        if (
          existsSync(path) ||
          this.list().some((entry) => entry.path === path)
        ) {
          throw new PluginError(
            "state_conflict",
            "Git workspace destination already exists. Open it instead or choose another name.",
          );
        }
        const branch = this.commands.run(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
          this.root,
        );
        if (branch.error || branch.status !== 1) {
          throw new PluginError(
            "state_conflict",
            "Git branch already exists or could not be checked. Choose a new workspace name; existing branches are never reset.",
          );
        }
        const parent = this.commands
          .git(this.root, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${base === "current" ? "HEAD" : base}^{commit}`,
          ])
          .trim();
        if (!/^[a-f0-9]{40,64}$/.test(parent) || /^0+$/.test(parent)) {
          throw new PluginError(
            "state_conflict",
            "Git workspace base must resolve to an existing commit. No fetch was attempted.",
          );
        }
        receipt = {
          name,
          path,
          source: this.root,
          base,
          parent,
          phase: "creating",
        };
        state.write(`git-create-${name}`, receipt);
      }
      if (!this.list().some((entry) => entry.path === path)) {
        if (receipt.phase === "ready" || existsSync(path)) {
          throw new PluginError(
            "state_conflict",
            "Git workspace no longer matches its creation receipt. Reconcile it before retrying.",
          );
        }
        try {
          this.commands.git(this.root, [
            "worktree",
            "add",
            "-b",
            name,
            "--",
            path,
            receipt.parent,
          ]);
        } catch (cause) {
          throw new PluginError(
            "partial_operation",
            `Git workspace creation paused at ${path}. Inspect the branch, checkout, and saved receipt before retrying; nothing was reset or removed.`,
            { cause },
          );
        }
      }
      const workspace = this.workspace(path);
      if (
        workspace.branch !== name ||
        (receipt.phase === "creating" && workspace.commitId !== receipt.parent)
      ) {
        throw new PluginError(
          "state_conflict",
          "Git workspace branch or commit no longer matches its creation receipt.",
        );
      }
      state.write(`git-create-${name}`, { ...receipt, phase: "ready" });
      return workspace;
    });
  }
}
