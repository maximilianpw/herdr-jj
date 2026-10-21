import { join } from "node:path";
import { parseArgs } from "node:util";
import { Commands, errorEnvelope, PluginError } from "./command";
import { Herdr, invocationContext, targetDirectory } from "./herdr";
import { runPopup } from "./popup";
import { Repository } from "./repository";
import { WorkspaceCatalog } from "./workspace-catalog";

const help = `herdr-jj — JJ and Git workspaces in one picker

  create NAME [--vcs jj|git] [--base BASE] [--no-open] [--focus]
  list [--vcs jj|git]
  open NAME_OR_PATH [--vcs jj|git] [--focus]
  status [--snapshot]
  cleanup NAME                         Preview; does not snapshot or move
  cleanup NAME --confirm /exact/path    Snapshot, pin recovery, ARCHIVE (no deletion)
  refresh                              Publish last-snapshot sidebar status

Common: --repo /absolute/path --state-dir /absolute/path
All noninteractive results/errors are JSON; failures exit 1. Help exits 0.
Creation defaults to JJ when available, otherwise Git.
JJ bases: trunk (default), current (NEW child of the snapshotted @ change).
Git bases: current (default, Git HEAD) or an explicit local commit/ref. Creates a new
branch named NAME; source edits stay untouched. Existing branches are never reset.
Opening never converts repositories. Cleanup/status remain JJ-only.
Use --vcs or an exact listed path when a name is ambiguous.
Closing a Herdr space never cleans up its checkout. Cleanup never closes panes.
Plugin-internal commands: action create|open|cleanup; pane create|open|cleanup.
`;

function popupAction(input: string | undefined): "create" | "open" | "cleanup" {
  if (input === "create" || input === "open" || input === "cleanup")
    return input;
  throw new PluginError(
    "invalid_input",
    "Unknown popup action. Use create, open or cleanup.",
  );
}

async function main(): Promise<unknown> {
  let args: ReturnType<typeof readArgs>;
  try {
    args = readArgs();
  } catch (cause) {
    throw new PluginError(
      "invalid_input",
      "Invalid command arguments. Run `herdr-jj --help` for supported commands and flags.",
      { cause },
    );
  }
  const { values, positionals } = args;
  const [command, name] = positionals;
  if (values.help || !command) {
    process.stdout.write(help);
    return undefined;
  }
  if (
    ![
      "create",
      "list",
      "open",
      "status",
      "cleanup",
      "refresh",
      "action",
      "pane",
    ].includes(command)
  ) {
    throw new PluginError(
      "invalid_input",
      "Unknown command. Run `herdr-jj --help` for supported commands.",
    );
  }
  const takesName = ["create", "open", "cleanup", "action", "pane"].includes(
    command,
  );
  if (positionals.length !== (takesName ? 2 : 1)) {
    throw new PluginError(
      "invalid_input",
      "Command has missing or extra arguments. Run `herdr-jj --help` for its syntax.",
    );
  }
  if (
    (values.confirm && command !== "cleanup") ||
    (values.snapshot && command !== "status") ||
    (values.base && command !== "create") ||
    (values.vcs && !["create", "list", "open"].includes(command)) ||
    (values["no-open"] && command !== "create") ||
    (values.focus && command !== "create" && command !== "open")
  ) {
    throw new PluginError(
      "invalid_input",
      "Flag does not apply to this command. Check `herdr-jj --help`; no operation was started.",
    );
  }
  const kind = values.vcs;
  if (kind !== undefined && kind !== "jj" && kind !== "git") {
    throw new PluginError("invalid_input", "Invalid VCS. Choose jj or git.");
  }
  const env = process.env;
  const commands = new Commands(env);
  const herdr = new Herdr(
    commands,
    env.HERDR_BIN_PATH ?? "herdr",
    process.cwd(),
  );
  if (command === "refresh") return herdr.refresh();
  const context = invocationContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const explicit =
    values.repo ?? (command === "pane" ? env.HERDR_JJ_TARGET : undefined);
  const path = targetDirectory(
    explicit,
    context,
    process.cwd(),
    Boolean(env.HERDR_PLUGIN_ID),
  );
  if (command === "status") {
    const repository = Repository.load(path, commands);
    if (values.snapshot) repository.snapshot();
    return {
      ...repository.status(),
      source: values.snapshot ? "snapshot-now" : "last-snapshot",
    };
  }
  if (command === "action")
    return herdr.popup(popupAction(name), context ?? {}, path);
  const workspaces = WorkspaceCatalog.load(
    path,
    commands,
    herdr,
    () =>
      values["state-dir"] ??
      join(env.HERDR_PLUGIN_CONFIG_DIR ?? herdr.configDirectory(), "state"),
  );
  if (command === "list") {
    return {
      workspaces: workspaces
        .list()
        .filter((entry) => !kind || entry.kind === kind),
    };
  }
  if (command === "pane") {
    try {
      await runPopup(popupAction(name), workspaces);
    } finally {
      // Bun can retain the keypress input handle after pause(); release the
      // popup's own stdin so Herdr observes process exit and dismisses it.
      process.stdin.destroy();
    }
    return undefined;
  }
  if (!name)
    throw new PluginError(
      "invalid_input",
      "Workspace name is required. Run `herdr-jj --help` for syntax.",
    );
  if (command === "create") {
    const workspace = workspaces.create(name, kind, values.base);
    const opened = values["no-open"]
      ? undefined
      : workspaces.open(name, values.focus ?? false, workspace.kind);
    return { workspace, opened };
  }
  if (command === "open")
    return workspaces.open(name, values.focus ?? false, kind);
  if (command === "cleanup")
    return values.confirm
      ? workspaces.cleanup(name, values.confirm)
      : workspaces.planCleanup(name);
  throw new PluginError(
    "invalid_input",
    "Command could not be dispatched. Check `herdr-jj --help`.",
  );
}

function readArgs() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      "state-dir": { type: "string" },
      base: { type: "string" },
      vcs: { type: "string" },
      "no-open": { type: "boolean" },
      focus: { type: "boolean" },
      snapshot: { type: "boolean" },
      confirm: { type: "string" },
    },
  });
}

try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify({ ok: true, result }));
} catch (cause) {
  console.error(JSON.stringify(errorEnvelope(cause)));
  process.exitCode = 1;
}
