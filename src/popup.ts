import { PluginError } from "./command";
import {
  InputDialog,
  readPopupTheme,
  runDialog,
  WorkspaceForm,
  WorkspacePicker,
} from "./popup-ui";
import type { WorkspaceCatalog } from "./workspace-catalog";

export async function runPopup(
  action: "create" | "open" | "cleanup",
  workspaces: WorkspaceCatalog,
): Promise<void> {
  const theme = readPopupTheme();
  try {
    if (action === "create") {
      const draft = await runDialog(
        new WorkspaceForm(
          {
            primary: workspaces.git.primary,
            allowJj: Boolean(workspaces.jj),
            allowCurrentJj: workspaces.jj?.root === workspaces.git.root,
          },
          theme,
        ),
      );
      workspaces.create(draft.name, draft.kind, draft.base);
      workspaces.open(draft.name, true, draft.kind);
      return;
    }
    const items = workspaces
      .list()
      .filter(
        (workspace) =>
          workspace.path &&
          (action !== "cleanup" ||
            (workspace.kind === "jj" &&
              workspace.path !== workspaces.jj?.primary)),
      );
    if (items.length === 0)
      throw new PluginError(
        "invalid_input",
        action === "cleanup"
          ? "No eligible JJ workspaces. Git cleanup is not supported."
          : "No workspaces are available in this repository.",
      );
    const selection = await runDialog(
      new WorkspacePicker(
        action === "open" ? "open workspace" : "archive JJ workspace",
        items.flatMap((item) =>
          item.path
            ? [
                {
                  id: item.path,
                  name: item.name,
                  path: item.path,
                  kind: item.kind,
                  current: item.path === workspaces.git.root,
                },
              ]
            : [],
        ),
        action === "open" ? "open" : "continue",
        theme,
      ),
    );
    const workspace = items.find((item) => item.path === selection);
    if (!workspace)
      throw new PluginError(
        "state_conflict",
        "Workspace selection was lost. Reopen the picker.",
      );
    if (action === "open") {
      workspaces.open(selection, true, workspace.kind);
      return;
    }
    const plan = workspaces.planCleanup(workspace.name);
    const confirmation = await runDialog(
      new InputDialog(
        "confirm archive",
        [
          "Close the target's Herdr space first.",
          "Tracked work is snapshotted and pinned. Files move to an archive; nothing is deleted. Ignored files block cleanup.",
          "Type the full path to confirm:",
          plan.path,
        ],
        "archive",
        theme,
      ),
    );
    const receipt = workspaces.cleanup(workspace.name, confirmation);
    await runDialog(
      new InputDialog(
        "Archived without deleting files",
        [receipt.archive, `Recovery: ${receipt.bookmark}`],
        "close",
        theme,
      ),
    );
  } catch (cause) {
    if (cause instanceof PluginError && cause.code === "cancelled") return;
    if (!process.stdin.isTTY) throw cause;
    const message =
      cause instanceof PluginError
        ? cause.message
        : "Operation failed. Inspect the repository and plugin state before retrying.";
    try {
      await runDialog(
        new InputDialog("workspace unavailable", [message], "close", theme),
      );
    } catch (dismissal) {
      if (!(dismissal instanceof PluginError && dismissal.code === "cancelled"))
        throw dismissal;
    }
    throw cause;
  }
}
