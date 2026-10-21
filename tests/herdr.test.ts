import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Herdr, invocationContext, targetDirectory } from "../src/herdr";
import { type Fixture, fixture } from "./fixtures";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});

test("plugin invocation resolves focused cwd, never plugin runtime cwd", () => {
  expect(
    targetDirectory(
      undefined,
      { focused_pane_cwd: f.repo, workspace_cwd: f.directory },
      "/wrong-plugin-root",
      true,
    ),
  ).toBe(f.repo);
  expect(
    targetDirectory(
      undefined,
      { workspace_cwd: f.repo },
      "/wrong-plugin-root",
      true,
    ),
  ).toBe(f.repo);
  expect(() => targetDirectory(undefined, {}, f.repo, true)).toThrow(
    "Repository target is missing",
  );
  expect(() => invocationContext('{"focused_pane_cwd":42}')).toThrow(
    "Invalid Herdr invocation context",
  );
  expect(() =>
    targetDirectory("relative/path", undefined, f.repo, false),
  ).toThrow("Repository target is missing");
});

test("linked workspace context overrides a pane that changed repositories", () => {
  expect(
    targetDirectory(
      undefined,
      { focused_pane_cwd: f.directory, worktree: { checkout_path: f.repo } },
      "/plugin",
      true,
    ),
  ).toBe(f.repo);
  expect(
    targetDirectory(
      f.directory,
      { worktree: { checkout_path: f.repo } },
      "/plugin",
      true,
    ),
  ).toBe(f.directory);
});

test("cleanup refuses a linked space even when every pane changed directory", () => {
  f.control({
    workspaces: [{ workspace_id: "w1", worktree: { checkout_path: f.repo } }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: f.directory }],
  });
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  expect(() => herdr.assertClosed(f.repo)).toThrow(
    "still bound to an open Herdr space",
  );
});

test("popup action pins invocation repo and respects Herdr's active-pane-only restriction", () => {
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  herdr.popup(
    "create",
    { workspace_id: "w1", focused_pane_id: "w1:p1" },
    f.repo,
  );
  expect(f.calls()).toEqual([
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "personal.herdr-jj",
      "--entrypoint",
      "create",
      "--env",
      `HERDR_JJ_TARGET=${f.repo}`,
    ],
  ]);
});

test("refresh prefers linked checkout, reports last snapshot and clears non-jj status", () => {
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  f.control({
    workspaces: [
      { workspace_id: "w1", worktree: { checkout_path: f.repo } },
      { workspace_id: "w2" },
    ],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", cwd: f.directory },
      { pane_id: "w2:p1", workspace_id: "w2", cwd: f.directory },
    ],
  });
  writeFileSync(join(f.repo, "unsnapshotted.txt"), "do not capture");
  expect(herdr.refresh()).toEqual({ refreshed: 1, unavailable: 1 });
  const calls = f.calls().map((call) => JSON.stringify(call));
  expect(
    calls.some(
      (call) => call.includes('"w1"') && call.includes('"jj_files=0"'),
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.includes('"w2"') && call.includes('"--clear-token","jj_status"'),
    ),
  ).toBe(true);
  expect(f.commands.jj(f.repo, ["file", "list"])).not.toContain(
    "unsnapshotted.txt",
  );
});

test("refresh exposes bookmarks as a separate token", () => {
  f.commands.jj(f.repo, ["bookmark", "set", "task-bookmark", "-r", "@"]);
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  f.control({
    workspaces: [{ workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: f.repo }],
  });
  herdr.refresh();
  expect(
    f
      .calls()
      .some((call) =>
        JSON.stringify(call).includes("jj_bookmark=task-bookmark"),
      ),
  ).toBe(true);
});

test("VCS sidebar prefers JJ and falls back to Git only after leaving JJ", () => {
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  const refresh = (cwd: string) => {
    f.control({
      workspaces: [{ workspace_id: "w1" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd }],
    });
    herdr.refresh();
    return f.calls().at(-1);
  };
  f.commands.jj(f.repo, ["bookmark", "set", "jj-task", "-r", "@"]);
  const jjCall = refresh(f.repo);
  expect(JSON.stringify(jjCall)).toContain("vcs_status=jj ");
  expect(jjCall).toContain("vcs_bookmark=jj-task");
  expect(JSON.stringify(jjCall)).not.toContain("vcs_status=git ");

  renameSync(join(f.repo, ".jj"), join(f.directory, "saved-jj"));
  f.commands.git(f.repo, ["switch", "-c", "git-only-topic", "main"]);
  f.commands.git(f.repo, ["branch", "--set-upstream-to=main"]);
  f.commands.git(f.repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "ahead",
  ]);
  const gitCall = refresh(f.repo);
  expect(gitCall).toContain("vcs_status=git git-only-topic ↑1");
  expect(gitCall).toContain("vcs_bookmark=");
  expect(JSON.stringify(gitCall)).toContain('"--clear-token","jj_status"');
  const emptyCall = refresh(f.directory);
  expect(JSON.stringify(emptyCall)).toContain('"--clear-token","vcs_status"');
  expect(JSON.stringify(emptyCall)).toContain('"--clear-token","vcs_bookmark"');
});

test("unsupported JJ colocation shows JJ unavailable, not misleading Git status", () => {
  f.commands.jj(f.repo, ["git", "colocation", "disable"], true);
  f.control({
    workspaces: [{ workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: f.repo }],
  });
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  herdr.refresh();
  expect(f.calls().at(-1)).toContain("vcs_status=jj unavailable");
});

test("Git fallback supports unborn and detached heads", () => {
  const gitRepo = join(f.directory, "git-only");
  mkdirSync(gitRepo);
  f.commands.git(gitRepo, ["init", "--initial-branch=unborn"]);
  f.control({
    workspaces: [{ workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: gitRepo }],
  });
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  herdr.refresh();
  expect(f.calls().at(-1)).toContain("vcs_status=git unborn");
  f.commands.git(gitRepo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  f.commands.git(gitRepo, ["checkout", "--detach"]);
  herdr.refresh();
  const head = f.commands
    .git(gitRepo, ["rev-parse", "HEAD"])
    .trim()
    .slice(0, 8);
  expect(f.calls().at(-1)).toContain(`vcs_status=git detached ${head}`);
});

test("malformed Herdr inventory fails closed", () => {
  f.control({ malformed: true });
  const herdr = new Herdr(
    f.commands,
    f.env.HERDR_BIN_PATH ?? "herdr",
    f.directory,
  );
  expect(() => herdr.assertClosed(f.repo)).toThrow();
});
