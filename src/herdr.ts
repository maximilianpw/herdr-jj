import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { type Commands, PluginError, parse, parseJson } from "./command";
import { containsPath, Repository } from "./repository";

export const PLUGIN_ID = "personal.herdr-jj";

function sidebarText(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(0, 120);
}
const contextSchema = z.object({
  focused_pane_cwd: z.string().nullable().optional(),
  workspace_cwd: z.string().nullable().optional(),
  focused_pane_id: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
  worktree: z.object({ checkout_path: z.string() }).nullable().optional(),
});
export type InvocationContext = z.infer<typeof contextSchema>;

export function invocationContext(
  raw: string | undefined,
): InvocationContext | undefined {
  return raw === undefined
    ? undefined
    : parse(contextSchema, parseJson(raw), "Herdr invocation context");
}

export function targetDirectory(
  explicit: string | undefined,
  context: InvocationContext | undefined,
  cwd: string,
  pluginInvocation: boolean,
): string {
  const path =
    explicit ??
    (pluginInvocation ? context?.worktree?.checkout_path : undefined) ??
    context?.focused_pane_cwd ??
    context?.workspace_cwd ??
    (pluginInvocation ? undefined : cwd);
  if (!path || !isAbsolute(path)) {
    throw new PluginError(
      "invalid_input",
      "Repository target is missing or relative. Supply an absolute --repo path; plugin runtime cwd is never used as the repository.",
    );
  }
  return realpathSync(path);
}

const paneSchema = z.object({
  pane_id: z.string(),
  workspace_id: z.string(),
  cwd: z.string().nullable().optional(),
  foreground_cwd: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  focused: z.boolean().optional(),
});
const panesSchema = z.object({ panes: z.array(paneSchema) });
const workspacesSchema = z.object({
  workspaces: z.array(
    z.object({
      workspace_id: z.string(),
      worktree: z.object({ checkout_path: z.string() }).nullable().optional(),
    }),
  ),
});

export class Herdr {
  constructor(
    private readonly commands: Commands,
    private readonly binary: string,
    private readonly cwd: string,
  ) {}

  call(args: string[]): unknown {
    const envelope = parse(
      z.object({ result: z.unknown() }),
      parseJson(this.commands.output(this.binary, args, this.cwd)),
      "Herdr response",
    );
    return envelope.result;
  }

  configDirectory(): string {
    const path = this.commands
      .output(this.binary, ["plugin", "config-dir", PLUGIN_ID], this.cwd)
      .trim();
    if (!isAbsolute(path)) {
      throw new PluginError(
        "invalid_response",
        "Herdr returned an invalid plugin config directory. Check the installed Herdr version.",
      );
    }
    return path;
  }

  panes() {
    return parse(panesSchema, this.call(["pane", "list"]), "Herdr pane list")
      .panes;
  }

  assertClosed(path: string): void {
    const panes = this.panes();
    // An idle agent or shell still owns the directory; require closing/moving it.
    const occupied = panes.some((pane) =>
      [pane.cwd, pane.foreground_cwd].some(
        (cwd) => cwd && containsPath(path, realpathSync(cwd)),
      ),
    );
    if (occupied || panes.some((pane) => !pane.cwd && !pane.foreground_cwd)) {
      throw new PluginError(
        "unsafe_cleanup",
        "Workspace still has a Herdr pane/agent, or a pane directory is unknown. Close the target's space and resolve unknown pane locations, then retry from another workspace.",
      );
    }
    const workspaces = parse(
      workspacesSchema,
      this.call(["workspace", "list"]),
      "Herdr workspace list",
    ).workspaces;
    if (
      workspaces.some(
        (workspace) =>
          workspace.worktree &&
          containsPath(path, realpathSync(workspace.worktree.checkout_path)),
      )
    ) {
      throw new PluginError(
        "unsafe_cleanup",
        "Workspace is still bound to an open Herdr space, even if its panes changed directory. Close that space before cleanup; closing keeps the checkout.",
      );
    }
  }

  open(
    primary: string,
    path: string,
    name: string,
    focus: boolean,
    kind: "jj" | "git" = "jj",
  ): unknown {
    // The workspace owner has already created and validated the checkout.
    return this.call([
      "worktree",
      "open",
      "--cwd",
      primary,
      "--path",
      path,
      "--label",
      `${kind}: ${name}`,
      focus ? "--focus" : "--no-focus",
    ]);
  }

  popup(
    entrypoint: "create" | "open" | "cleanup",
    context: InvocationContext,
    path: string,
  ): unknown {
    if (!context.workspace_id || !context.focused_pane_id) {
      throw new PluginError(
        "invalid_input",
        "Popup target is missing. Invoke the action from a workspace pane.",
      );
    }
    // Herdr 0.9.5 rejects pane/workspace selectors for popups. Pin the
    // invocation's repository in env instead of relying on popup runtime cwd.
    this.commands.output(
      this.binary,
      [
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        entrypoint,
        "--env",
        `HERDR_JJ_TARGET=${path}`,
      ],
      this.cwd,
    );
    return { popup: entrypoint };
  }

  private gitSidebarStatus(cwd: string): string | undefined {
    const root = this.commands.run(
      "git",
      ["rev-parse", "--show-toplevel"],
      cwd,
    );
    if (root.error || root.status !== 0) return undefined;
    // A failed JJ invocation must not turn a JJ checkout into a Git-only row.
    if (existsSync(join(root.stdout.trim(), ".jj"))) return "jj unavailable";
    const result = this.commands.run(
      "git",
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=no",
        "--ignore-submodules",
      ],
      cwd,
    );
    if (result.error || result.status !== 0) return undefined;
    const head = /^# branch\.head (.+)$/m.exec(result.stdout)?.[1];
    if (!head) return undefined;
    const oid = /^# branch\.oid ([a-f0-9]+)$/m.exec(result.stdout)?.[1];
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(result.stdout);
    const ahead = counts?.[1] && counts[1] !== "0" ? ` ↑${counts[1]}` : "";
    const behind = counts?.[2] && counts[2] !== "0" ? ` ↓${counts[2]}` : "";
    const branch =
      head === "(detached)" ? `detached ${oid?.slice(0, 8) ?? ""}` : head;
    return sidebarText(`git ${branch}${ahead}${behind}`);
  }

  refresh(): { refreshed: number; unavailable: number } {
    const workspaces = parse(
      workspacesSchema,
      this.call(["workspace", "list"]),
      "Herdr workspace list",
    ).workspaces;
    const panes = this.panes();
    let refreshed = 0;
    let unavailable = 0;
    const seq = String(Date.now());
    for (const workspace of workspaces) {
      const workspacePanes = panes.filter(
        (pane) => pane.workspace_id === workspace.workspace_id,
      );
      const pane =
        workspacePanes.find((pane) => pane.focused) ?? workspacePanes[0];
      const cwd =
        workspace.worktree?.checkout_path ?? pane?.foreground_cwd ?? pane?.cwd;
      let tokens: string[];
      try {
        if (!cwd) throw new PluginError("not_jj", "No pane directory.");
        const status = Repository.load(cwd, this.commands).status();
        const bookmark = sidebarText(status.bookmarks.join(","));
        const summary = `jj ${status.changeId}${status.conflict ? " !" : ""} ~${status.files}`;
        tokens = [
          "--token",
          `jj_change=${status.changeId}`,
          "--token",
          `jj_bookmark=${bookmark}`,
          "--token",
          `jj_conflict=${status.conflict ? "CONFLICT" : ""}`,
          "--token",
          `jj_files=${status.files}`,
          "--token",
          `jj_status=${summary}`,
          "--token",
          `vcs_status=${summary}`,
          "--token",
          `vcs_bookmark=${bookmark}`,
        ];
        refreshed++;
      } catch (cause) {
        if (!(cause instanceof PluginError)) throw cause;
        tokens = [
          "jj_change",
          "jj_bookmark",
          "jj_conflict",
          "jj_files",
          "jj_status",
        ].flatMap((token) => ["--clear-token", token]);
        const fallback = cwd
          ? cause.code === "not_jj"
            ? this.gitSidebarStatus(cwd)
            : "jj unavailable"
          : undefined;
        tokens.push(
          ...(fallback
            ? ["--token", `vcs_status=${fallback}`, "--token", "vcs_bookmark="]
            : ["--clear-token", "vcs_status", "--clear-token", "vcs_bookmark"]),
        );
        unavailable++;
      }
      this.commands.output(
        this.binary,
        [
          "workspace",
          "report-metadata",
          workspace.workspace_id,
          "--source",
          PLUGIN_ID,
          "--seq",
          seq,
          "--ttl-ms",
          "300000",
          ...tokens,
        ],
        this.cwd,
      );
    }
    return { refreshed, unavailable };
  }
}
