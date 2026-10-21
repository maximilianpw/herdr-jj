import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { PluginError } from "./command";
import type { Herdr } from "./herdr";
import { containsPath, type Repository, workspaceName } from "./repository";
import type { PluginState } from "./state";

const creationSchema = z.object({
  name: z.string(),
  path: z.string(),
  source: z.string(),
  base: z.enum(["trunk", "current"]),
  parent: z.string(),
  phase: z.enum(["creating", "ready"]),
});

const cleanupSchema = z.object({
  name: z.string(),
  path: z.string(),
  archive: z.string(),
  gitDir: z.string(),
  commitId: z.string(),
  bookmark: z.string(),
  phase: z.enum(["prepared", "archived"]),
});
export type CleanupReceipt = z.infer<typeof cleanupSchema>;

export class Workspaces {
  constructor(
    private readonly repository: Repository,
    private readonly state: PluginState,
    private readonly herdr: Herdr,
  ) {}

  create(nameInput: string, base: "trunk" | "current") {
    const name = workspaceName(nameInput);
    return this.state.withLock(() => {
      const repo = this.repository;
      const path = join(
        dirname(repo.primary),
        `${basename(repo.primary)}.jj-${name}`,
      );
      if (this.state.read(`cleanup-${name}`, cleanupSchema)) {
        throw new PluginError(
          "state_conflict",
          "Workspace name has a cleanup journal. Choose a new name so recovery records remain unambiguous.",
        );
      }
      let receipt = this.state.read(`create-${name}`, creationSchema);
      if (
        receipt &&
        (receipt.path !== path ||
          receipt.source !== repo.root ||
          receipt.base !== base)
      ) {
        throw new PluginError(
          "state_conflict",
          "Workspace creation retry does not match its saved request. Use the original source and base, or open the existing workspace.",
        );
      }
      if (!receipt) {
        if (
          existsSync(path) ||
          repo.list().some((item) => item.name === name)
        ) {
          throw new PluginError(
            "state_conflict",
            "Workspace name or destination already exists. Open it instead, or choose another name.",
          );
        }
        const parent = repo.resolveBase(base);
        if (!/^[a-f0-9]{40,64}$/.test(parent) || /^0+$/.test(parent)) {
          throw new PluginError(
            "state_conflict",
            "Base must resolve to one non-root commit. Configure `trunk()` explicitly (jj may silently substitute root for an invalid alias), or create the first commit, then retry. No network fetch was attempted.",
          );
        }
        receipt = {
          name,
          path,
          source: repo.root,
          base,
          parent,
          phase: "creating",
        };
        this.state.write(`create-${name}`, receipt);
      }
      const existing = repo.list().find((item) => item.name === name);
      if (!existing) {
        if (receipt.phase === "ready" || existsSync(path)) {
          throw new PluginError(
            "partial_operation",
            `Workspace creation needs reconciliation at ${path}. Inspect it and the saved creation receipt; no directory was overwritten or removed.`,
          );
        }
        try {
          repo.commands.jj(
            repo.root,
            [
              "workspace",
              "add",
              "--colocate",
              "--sparse-patterns",
              "full",
              "--name",
              name,
              "-r",
              receipt.parent,
              path,
            ],
            true,
          );
        } catch (cause) {
          throw new PluginError(
            "partial_operation",
            `jj workspace creation did not finish cleanly at ${path}. Retry the same request to reconcile, or inspect with jj; no Git-only fallback was attempted.`,
            { cause },
          );
        }
      }
      const workspace = repo.workspace(name);
      if (workspace.path !== path) {
        throw new PluginError(
          "state_conflict",
          "Existing workspace does not match the creation receipt. Reconcile its path before retrying.",
        );
      }
      if (
        receipt.phase === "creating" &&
        repo.commands
          .jj(path, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
          .trim() !== receipt.parent
      ) {
        throw new PluginError(
          "state_conflict",
          "Workspace parent no longer matches the pending creation receipt. Inspect it and use open rather than replaying creation.",
        );
      }
      this.state.write(`create-${name}`, { ...receipt, phase: "ready" });
      return workspace;
    });
  }

  open(name: string, focus: boolean): unknown {
    const workspace = this.repository.workspace(name);
    try {
      return this.herdr.open(
        this.repository.primary,
        workspace.path,
        workspace.name,
        focus,
      );
    } catch (cause) {
      throw new PluginError(
        "partial_operation",
        `Checkout is retained at ${workspace.path}, but Herdr open did not complete. Inspect Herdr's workspace list, then retry open; do not create a replacement checkout.`,
        { cause },
      );
    }
  }

  private assertQuiescent(path: string): void {
    this.herdr.assertClosed(path);
    const result = this.repository.commands.run(
      "lsof",
      ["-nP", "-a", "-u", String(process.getuid?.() ?? -1), "+D", path, "-Fpn"],
      this.repository.primary,
    );
    if (
      result.error ||
      result.stderr.trim() ||
      (result.status !== 0 && result.status !== 1)
    ) {
      throw new PluginError(
        "unsafe_cleanup",
        "Process safety check is unavailable or incomplete. Install/fix lsof and retry; cleanup never assumes an unreadable process list is safe.",
      );
    }
    if (result.stdout.trim() || result.status === 0) {
      throw new PluginError(
        "unsafe_cleanup",
        "Workspace has an active process, open file, or working directory. Stop those processes (including idle agents/shells) and retry from elsewhere.",
      );
    }
  }

  private checkTarget(name: string): {
    path: string;
    ignored: number;
    untracked: number;
  } {
    const repo = this.repository;
    const { path } = repo.workspace(name);
    if (
      containsPath(path, repo.primary) ||
      containsPath(repo.primary, path) ||
      containsPath(path, repo.root) ||
      containsPath(path, realpathSync(process.cwd()))
    ) {
      throw new PluginError(
        "unsafe_cleanup",
        "Cleanup cannot target the primary, current, or a nested primary checkout. Run it from the primary workspace against a separate secondary checkout.",
      );
    }
    if (
      !lstatSync(join(path, ".git")).isFile() ||
      !lstatSync(join(path, ".jj", "repo")).isFile()
    ) {
      throw new PluginError(
        "unsafe_cleanup",
        "Cleanup target is not a linked colocated workspace. Reconcile its repository layout first.",
      );
    }
    this.state.assertOutside(path);
    if (
      repo
        .list()
        .some(
          (workspace) =>
            workspace.name !== name &&
            workspace.path &&
            containsPath(path, resolve(workspace.path)),
        )
    ) {
      throw new PluginError(
        "unsafe_cleanup",
        "Cleanup target contains another jj workspace. Move or reconcile the nested workspace first.",
      );
    }
    this.assertQuiescent(path);
    return {
      path,
      ignored: repo.ignoredFiles(path).length,
      untracked: repo.untrackedFiles(path).length,
    };
  }

  planCleanup(nameInput: string) {
    const name = workspaceName(nameInput);
    const receipt = this.state.read(`cleanup-${name}`, cleanupSchema);
    if (receipt) return { ...receipt, recovery: true };
    const target = this.checkTarget(name);
    return {
      name,
      ...target,
      phase: "preview",
      policy: "archive; never delete files",
      confirmation: target.path,
    };
  }

  cleanup(nameInput: string, confirmation: string): CleanupReceipt {
    const name = workspaceName(nameInput);
    return this.state.withLock(() => {
      const repo = this.repository;
      let receipt = this.state.read(`cleanup-${name}`, cleanupSchema);
      if (receipt && confirmation !== receipt.path) {
        throw new PluginError(
          "invalid_input",
          "Cleanup confirmation must exactly match the original absolute checkout path. Preview cleanup before confirming.",
        );
      }
      if (receipt?.phase === "archived") return receipt;
      if (!receipt) {
        const target = this.checkTarget(name);
        if (confirmation !== target.path) {
          throw new PluginError(
            "invalid_input",
            "Cleanup confirmation must exactly match the absolute checkout path. Preview cleanup before confirming.",
          );
        }
        if (target.ignored > 0) {
          throw new PluginError(
            "unsafe_cleanup",
            "Cleanup found ignored files (possibly secrets or local databases). Move them somewhere safe and retry; a jj snapshot does not preserve them.",
          );
        }
        repo.snapshot(target.path);
        if (repo.untrackedFiles(target.path).length > 0) {
          throw new PluginError(
            "unsafe_cleanup",
            "Cleanup found files jj did not snapshot. Track them explicitly or move them to safety, then retry.",
          );
        }
        const status = repo.status(target.path);
        if (status.conflict) {
          throw new PluginError(
            "unsafe_cleanup",
            "Cleanup found unresolved conflicts. Resolve them before archiving this workspace.",
          );
        }
        const id = randomUUID();
        receipt = {
          name,
          path: target.path,
          archive: join(
            dirname(repo.primary),
            `${basename(repo.primary)}.jj-archives`,
            `${name}-${id}`,
          ),
          gitDir: realpathSync(
            repo.commands
              .git(target.path, ["rev-parse", "--absolute-git-dir"])
              .trim(),
          ),
          commitId: status.commitId,
          bookmark: `herdr-jj-recovery/${id}`,
          phase: "prepared",
        };
        this.state.write(`cleanup-${name}`, receipt);
      }
      try {
        if (existsSync(receipt.path)) {
          if (existsSync(receipt.archive))
            throw new PluginError(
              "state_conflict",
              "Both original and archive paths exist. Reconcile them manually; neither will be removed.",
            );
          const target = this.checkTarget(name);
          if (
            target.path !== receipt.path ||
            target.ignored > 0 ||
            target.untracked > 0 ||
            realpathSync(
              repo.commands
                .git(target.path, ["rev-parse", "--absolute-git-dir"])
                .trim(),
            ) !== receipt.gitDir
          ) {
            throw new PluginError(
              "state_conflict",
              "Workspace changed after cleanup was prepared. Reconcile the journal before proceeding; all files are retained.",
            );
          }
          repo.snapshot(target.path);
          if (
            repo.status(target.path).commitId !== receipt.commitId ||
            repo.ignoredFiles(target.path).length > 0 ||
            repo.untrackedFiles(target.path).length > 0
          ) {
            throw new PluginError(
              "state_conflict",
              "Workspace changed after cleanup was prepared. Reconcile the journal before proceeding; all files are retained.",
            );
          }
          repo.commands.jj(repo.primary, [
            "bookmark",
            "set",
            receipt.bookmark,
            "-r",
            receipt.commitId,
          ]);
          mkdirSync(dirname(receipt.archive), { recursive: true, mode: 0o700 });
          if (
            realpathSync(dirname(receipt.archive)) !== dirname(receipt.archive)
          ) {
            throw new PluginError(
              "unsafe_cleanup",
              "Archive directory is a symbolic link. Use a real sibling directory before retrying.",
            );
          }
          // Move, never delete: even files arriving after the safety scan survive.
          repo.commands.git(repo.primary, [
            "worktree",
            "move",
            receipt.path,
            receipt.archive,
          ]);
        }
        if (
          !existsSync(receipt.archive) ||
          realpathSync(receipt.archive) !== receipt.archive ||
          realpathSync(
            repo.commands
              .git(receipt.archive, ["rev-parse", "--absolute-git-dir"])
              .trim(),
          ) !== receipt.gitDir
        ) {
          throw new PluginError(
            "state_conflict",
            "Archive identity cannot be verified. Reconcile the original checkout and journal manually.",
          );
        }
        const remaining = repo
          .list()
          .find((workspace) => workspace.name === name);
        if (remaining) {
          if (
            remaining.path !== receipt.path ||
            remaining.commitId !== receipt.commitId
          ) {
            throw new PluginError(
              "state_conflict",
              "Workspace registration changed during cleanup. Reconcile it before forgetting anything; the archived files are retained.",
            );
          }
          repo.commands.jj(repo.primary, ["workspace", "forget", name]);
        }
        const completed = { ...receipt, phase: "archived" as const };
        this.state.write(`cleanup-${name}`, completed);
        return completed;
      } catch (cause) {
        if (cause instanceof PluginError && cause.code !== "command_failed")
          throw cause;
        throw new PluginError(
          "partial_operation",
          `Cleanup paused. Files are at ${receipt.path} or ${receipt.archive}; recovery bookmark is ${receipt.bookmark}. Retry the same cleanup command to reconcile. No recursive or forced deletion is used.`,
          { cause },
        );
      }
    });
  }
}
