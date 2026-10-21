# JJ / Git Workspaces for Herdr

A personal, JJ-first Herdr plugin. Create and open **colocated JJ workspaces and Git worktrees** through one picker, and archive completed JJ checkouts without deleting their files. Git is an explicit creation choice, not a fallback after JJ fails. No fork, shell aliases, automatic migration, network fetch, or push.

## Requirements and local setup

- Herdr **0.9.5+**, jj **0.46+**, Git, and `lsof` on macOS or Linux.
- Bun **1.3.14+** to build/develop. The compiled executable does not need Bun at runtime.
- `uv` and Python 3.10+ for the isolated real-Herdr verification script. `uv` supplies its pinned `pyte` terminal renderer in an isolated environment.

```sh
bun install --frozen-lockfile
bun run check
bun run build
./dist/herdr-jj --help
```

**Linking is a separate deployment step.** It registers executable code globally across your Herdr sessions. Nothing in the build or ordinary test suite does that. Only when you want to install it:

```sh
herdr plugin link /absolute/path/to/herdr-jj
herdr plugin action list --plugin personal.herdr-jj
```

`plugin link` does not build. Rebuild after source changes; new invocations use the new executable. Unlinking with `herdr plugin unlink personal.herdr-jj` leaves source, checkouts, archives, and journals intact.

Git-only repositories can be listed, opened, and used to create Git worktrees without conversion. To enable JJ, review the repository state and **explicitly** opt in yourself:

```sh
cd /path/to/repository
jj git init --colocate
```

Opening or creating a workspace never runs that command for you. JJ is the default creation type when the primary repository has JJ; otherwise Git is the only available type. Existing non-colocated jj repositories require explicit `jj git colocation enable`. The plugin supports ordinary colocated repositories and submodule-backed repositories whose `.git` file points into the superproject. It resolves the primary checkout through JJ's `.jj/repo` metadata and verifies that JJ, Git, and the primary checkout share the same Git repository; bare repositories and mismatched metadata are refused. Set up a first commit and a meaningful `trunk()` before creating workspaces; a virtual-root base is refused.

## Herdr keys and sidebar

Merge the relevant entries from [`docs/herdr-config.toml`](docs/herdr-config.toml) into your own Herdr configuration. **Do not replace your config with the example.** Check for existing key conflicts. The plugin does not modify your settings.

| Action                             | Example key | Behavior                                                 |
| ---------------------------------- | ----------- | -------------------------------------------------------- |
| `personal.herdr-jj.create`         | prefix+j    | One form: name, JJ/Git type, base, live checkout preview |
| `personal.herdr-jj.open`           | prefix+o    | Counted picker of existing JJ and Git workspaces         |
| `personal.herdr-jj.cleanup`        | prefix+x    | Preview and confirm archive; target must be closed/idle  |
| `personal.herdr-jj.refresh-status` | prefix+r    | Publish last-snapshot status                             |

The terminal popups follow Herdr's native dialog layout: compact fields, highlighted two-line workspace rows, muted paths, and footer buttons. They remain plugin terminal popups, not native dialog APIs.
- **Create:** type the name, use **Tab / Shift+Tab** to change fields and **←/→** to choose JJ/Git or the JJ base. Git accepts an editable commit/ref. **Enter** creates and opens directly; invalid names stay in the form. The checkout path updates as you type.
- **Open:** type or press **/** to filter names, paths, and VCS types. **↑/↓**, **Page Up/Down**, and **Home/End** navigate the list; **Enter** opens the selected result. **Esc** clears an active filter, then closes the picker; **Ctrl+C** closes immediately. Empty results never open a workspace.
- **Text fields:** cursor editing, **Home/End**, and **Ctrl+A/E/U** are supported. Layouts redraw on terminal resize without animations.
- Colors match Herdr's default Catppuccin palette and the relevant top-level `theme.custom` overrides from its config. Other themes fall back to terminal ANSI colors; native theme switching is not exposed to plugins.

Creation opens and focuses the new Herdr space. Workspace names are 1–64 letters/digits/hyphens/underscores, starting with a letter or digit. Checkouts go beside the primary repository as `<repo>.jj-<name>` or `<repo>.git-<name>`. The Git choice creates a **new branch named `<name>`**, from the current Git commit or an explicit local commit/ref; it never resets an existing branch or copies source edits. Existing Git worktrees can be opened by their full branch name or exact path, including branches with slashes.
- **New task from trunk:** a new change on locally known `trunk()`. No fetch; fetch explicitly with jj when appropriate.
- **Continue current change:** snapshot the source, then create a **new child of `@`**. It copies the current work into a new line of development, not a second editor for the exact same change.
- JJ creation snapshots the source; Git creation, list, open, cleanup preview, and default status do not. JJ current-change continuation requires a JJ source checkout; from a Git-only sibling, start from JJ trunk or open a JJ workspace first. Resolving a trunk base alone does not snapshot, so an invalid trunk is refused before changing the source. New checkouts always include all files, even when the source uses sparse patterns.
- JJ creates its checkout with `--colocate`; Git creates a worktree with a new branch. Only then does the plugin call `herdr worktree open` for native grouping.
- The picker labels and counts both types. Colocated JJ checkouts appear once, as JJ, and archived/unregistered `.jj` checkouts are never relabeled as active Git workspaces. Duplicate names require a VCS selector or exact checkout path.
- The cleanup action remains JJ-only. Git worktrees are not removed or archived by this plugin.

### Honest status

Use `$vcs_status` and `$vcs_bookmark` in the sidebar instead of the built-in `branch`/`git_status` rows. JJ workspaces show `jj <change> ~<files>` and bookmarks; Git-only repositories show `git <branch>` with nonzero ahead/behind counts (or a detached commit). Unavailable JJ metadata shows `jj unavailable`, not Git status. Non-repository targets clear both tokens.

The existing `$jj_status`, `$jj_change`, `$jj_bookmark`, `$jj_conflict`, and `$jj_files` tokens remain available for custom layouts. They are cleared outside supported JJ workspaces.

All automatic reads use `--ignore-working-copy`. File count means **files changed in the last jj snapshot of `@` relative to its parents**, not a live filesystem/untracked-file count. JJ bookmark tokens show bookmarks on `@`, not necessarily its parent. `CONFLICT` flags a conflicted snapshot.

Status refreshes on startup, workspace creation/focus, and the refresh action. Both JJ and Git fallback tokens expire after five minutes; there is no polling daemon or after-every-shell-command guarantee. Run `jj status` or `herdr-jj status --snapshot`, then refresh when you need a newly snapshotted view. Non-jj/unavailable targets clear stale tokens. Linked Herdr spaces use their checkout path; other spaces use a focused pane or the first available pane.

Herdr v1 plugins cannot replace native Git context menus or change all native branch labels. The VCS sidebar layout suppresses the Git status row for JJ workspaces, but does not change those menus. Use these actions instead of the built-in Git create/remove-worktree actions for jj checkouts.

## Noninteractive agent surface

Commands return one JSON result on stdout. Errors go to stderr with `code`, `message`, `details`, `requestId`, and `retryable`; exit status is 1. `busy` and journaled `partial_operation` failures allow retrying the **exact same request**; all other failures need correction/reconciliation first. No mutation is automatically retried. Prefer explicit absolute `--repo` paths. Plugin invocations use the linked Herdr checkout when present, otherwise the captured focused-pane/workspace cwd—**never the plugin installation directory**. An explicit `--repo` always wins.

```sh
PLUGIN=/absolute/path/to/herdr-jj/dist/herdr-jj
REPO=/absolute/path/to/project

"$PLUGIN" list --repo "$REPO"
"$PLUGIN" create api-fix --repo "$REPO" --base trunk
"$PLUGIN" create follow-up --repo "$REPO" --base current --no-open
"$PLUGIN" create git-task --repo "$REPO" --vcs git --base main --no-open
"$PLUGIN" list --repo "$REPO" --vcs git
"$PLUGIN" open git-task --repo "$REPO" --vcs git
"$PLUGIN" open /absolute/path/to/checkout --repo "$REPO"
"$PLUGIN" open follow-up --repo "$REPO"          # no focus change by default
"$PLUGIN" open follow-up --repo "$REPO" --focus
"$PLUGIN" status --repo "$REPO"                 # last snapshot only
"$PLUGIN" status --repo "$REPO" --snapshot      # explicit snapshot
"$PLUGIN" refresh
```

Keep using jj inside a JJ checkout: `jj status`, `jj diff`, `jj describe`, `jj new`, `jj log`, and explicit bookmark/fetch/push commands when authorized. Do not switch a JJ task to Git commits, branches, or stash. Git workspaces use the normal Git workflow; selecting Git does not initialize JJ there. Git read-only commands and tools can use the colocated `.git` normally. Do not publish/push merely because local work is complete.

Journals and per-repository locks are shared between popup and CLI under:

```text
$(herdr plugin config-dir personal.herdr-jj)/state/<repository-hash>/
```

This plugin-owned config subdirectory is intentional: Herdr exposes `config-dir` to standalone agents, whereas its runtime state-directory environment is only injected into plugin commands. No state is stored in the plugin source or user repositories. `--state-dir /absolute/path` overrides the root for isolated/offline use; use the **same override for all retries**. The CLI can create without contacting a Herdr server using `--no-open --state-dir ...`; opening, status publication, and cleanup safety checks require the server.

## Cleanup means archive, not erase

**Closing a Herdr space never removes its checkout.** Cleanup never closes panes, stops agents, or assumes an idle agent is safe to move.

From another checkout (normally the primary):

```sh
"$PLUGIN" cleanup api-fix --repo "$REPO"       # preview only
"$PLUGIN" cleanup api-fix --repo "$REPO" \
  --confirm /absolute/path/to/project.jj-api-fix
```

Cleanup:
1. Verifies the jj/Git repository, recorded path and working-copy identity. Refuses primary/current/nested-primary workspaces, symlink substitutions, nested jj workspaces, or state inside the target.
2. Requires the linked Herdr space to be closed, no other pane pointing into the target, and no current-user process with its cwd or open files there (`lsof`). Unavailable/incomplete inventories fail closed.
3. Refuses ignored files (including `.env`, databases, ignored build trees). Move them somewhere safe first. Snapshots eligible tracked/new files explicitly; refuses files jj did not track and unresolved conflicts. Re-snapshots after safety checks and refuses changes since preparation, including on retries.
4. Saves a journal and pins `herdr-jj-recovery/<uuid>` to the snapshot.
5. Moves the **whole checkout**, without `--force`, to `<repo>.jj-archives/<name>-<uuid>` using Git's worktree-aware move. Git is used here only to maintain compatibility metadata during the move.
6. Verifies the archive identity and forgets exactly the recorded jj workspace, leaving its change pinned and **all files on disk**.

Archiving rather than deleting also protects files arriving after the safety scan. It **does not reclaim disk space**, purge archives, remove recovery bookmarks, or unregister archived Git worktrees. There is deliberately no automatic purge/force-delete feature. The archive remains a Git worktree; its old `.jj` metadata is not a usable active jj workspace after forgetting. Do not open it as an active task through jj or Herdr's Git menus.

Process checks are conservative, local, and current-user only. They cannot establish global quiescence on shared/network filesystems or across other users; those environments are not supported for cleanup. Stop writers yourself. A snapshot/operation log is not a backup for ignored files.

### Failure and recovery

- **Creation failed:** the request receipt is retained. Retry the exact name, source, and base to reconcile. Existing unrelated paths are never adopted or overwritten. If the checkout exists but Herdr open failed, inspect Herdr's space list and retry **open**, not a new Git worktree.
- **Cleanup failed:** files stay at the original or journaled archive path. Retry the same command and exact original confirmation path; the saved identity guards against forgetting a replacement workspace. Files are never recursively removed as a fallback.
- **Interrupted process:** its lock intentionally remains. Inspect `lock/owner.json`, verify that process and all other plugin mutations have ended, then remove only that lock's owner file and empty directory. Do not delete the whole state directory to bypass an unexplained refusal.
- **Workspace changed after cleanup was prepared:** automatic continuation refuses. Inspect the journal, original/archive paths, jj workspace list and recovery bookmark before manually reconciling. Keep all files and use a fresh name rather than guessing.
- **Restore completed work:** create a new colocated workspace from the receipt's exact recovery bookmark, e.g. `jj workspace add --colocate --name recovered -r 'herdr-jj-recovery/<uuid>' /new/path`. Inspect/copy any extra files from the archive yourself; never copy its `.git` or `.jj` metadata into a new checkout. This reconstructs the snapshot as the new workspace's parent. Archives/journals are retained for manual recovery, not managed backups.

Archived names are reserved by their cleanup journals. Use a new task name instead of reusing one and making recovery ambiguous.

## Verification

```sh
bun run check           # typecheck, Biome, real jj/Git + fake-Herdr boundary tests
bun run verify:herdr    # build + real isolated Herdr server and terminal client
```

The real-surface check uses a temporary HOME/config/registry, asserts isolation before linking, creates only disposable repositories, and stops only its own named server. It exercises compiled CLI actions, grouping, metadata, close-vs-cleanup separation, the actual popup keybinding, creation, cancellation, and shared CLI/popup journals. Logs/terminal evidence live in ignored `.verification/`. Nothing is linked into the active user session. Automated checks are exercised on macOS; Linux support is implemented but still needs a Linux run.

## References and ownership

Implementation is original to this project. Herdr's [plugin](https://herdr.dev/docs/plugins/), [CLI](https://herdr.dev/docs/cli-reference/), and [socket](https://herdr.dev/docs/socket-api/) contracts define the integration. Installed jj help is authoritative for colocation; older [Git compatibility docs](https://docs.jj-vcs.dev/latest/git-compatibility/) may lag the Git-worktree support in jj 0.46.

[OliverGilan/herdr-jj](https://github.com/OliverGilan/herdr-jj) and [mroth/herdr-jj-status](https://github.com/mroth/herdr-jj-status) informed the initial exploration. No implementation code was vendored. This project's archive-only policy is deliberately different from force-removal workflows.
