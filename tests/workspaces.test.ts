import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse } from "../src/command";
import { type Fixture, fixture } from "./fixtures";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});

function success(args: string[]) {
  const result = f.cli(args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.json();
}
function failure(args: string[], code: string) {
  const result = f.cli(args);
  expect(result.status).toBe(1);
  expect(result.json()).toMatchObject({
    ok: false,
    error: { code, retryable: code === "busy" || code === "partial_operation" },
  });
}
function create(name = "task") {
  success(["create", name, "--no-open"]);
}
function cleanupReceipt(value: unknown) {
  return parse(
    z.object({
      result: z.object({
        archive: z.string(),
        bookmark: z.string(),
        phase: z.string(),
      }),
    }),
    value,
    "test receipt",
  ).result;
}

test("create enforces colocation even when jj config disables it; Git can read it", () => {
  f.commands.jj(f.repo, ["config", "set", "--repo", "git.colocate", "false"]);
  create();
  expect(existsSync(join(f.path("task"), ".git"))).toBe(true);
  expect(readFileSync(join(f.path("task"), "hello.txt"), "utf8")).toBe(
    "trunk\n",
  );
  expect(f.commands.git(f.path("task"), ["status", "--porcelain"])).toBe("");
  expect(f.commands.git(f.repo, ["worktree", "list"])).toContain(
    f.path("task"),
  );
  expect(f.calls()).toEqual([]);
});

test("trunk and current are distinct; continuation snapshots source and creates a child", () => {
  writeFileSync(join(f.repo, "hello.txt"), "continuation\n");
  create("from-trunk");
  success(["create", "from-current", "--base", "current", "--no-open"]);
  expect(readFileSync(join(f.path("from-trunk"), "hello.txt"), "utf8")).toBe(
    "trunk\n",
  );
  expect(readFileSync(join(f.path("from-current"), "hello.txt"), "utf8")).toBe(
    "continuation\n",
  );
  const parent = f.commands.jj(f.path("from-current"), [
    "log",
    "-r",
    "@-",
    "--no-graph",
    "-T",
    "commit_id",
  ]);
  expect(parent).toBe(
    f.commands.jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]),
  );
});

test("Herdr open is separate, no Git worktree create and no focus by default", () => {
  success(["create", "task"]);
  expect(f.calls()).toContainEqual([
    "worktree",
    "open",
    "--cwd",
    f.repo,
    "--path",
    f.path("task"),
    "--label",
    "jj: task",
    "--no-focus",
  ]);
  expect(
    f.calls().some((call) => JSON.stringify(call).includes('"create"')),
  ).toBe(false);
});

test("open failure retains checkout; create retry and open retry do not duplicate it", () => {
  f.control({ failOpen: true });
  failure(["create", "task"], "partial_operation");
  expect(existsSync(f.path("task"))).toBe(true);
  f.control({});
  success(["create", "task"]);
  success(["open", "task"]);
  expect(
    f.commands
      .jj(f.repo, ["workspace", "list", "-T", 'name ++ "\n"'])
      .trim()
      .split("\n"),
  ).toEqual(["default", "task"]);
});

test("jj failure never falls back to Herdr create; exact request can be retried", () => {
  f.control({ failAdd: true });
  failure(["create", "task"], "partial_operation");
  expect(f.calls()).toEqual([]);
  f.control({});
  success(["create", "task", "--no-open"]);
  failure(
    ["create", "task", "--base", "current", "--no-open"],
    "state_conflict",
  );
});

test("existing directory and unsafe names are never overwritten", () => {
  mkdirSync(f.path("task"));
  writeFileSync(join(f.path("task"), "keep"), "safe");
  failure(["create", "task", "--no-open"], "state_conflict");
  failure(["create", "../escape", "--no-open"], "invalid_input");
  failure(["create", "x;touch-pwned", "--no-open"], "invalid_input");
  expect(readFileSync(join(f.path("task"), "keep"), "utf8")).toBe("safe");
});

test("Git-only repos can be listed without conversion, but JJ creation requires opt-in", () => {
  renameSync(join(f.repo, ".jj"), join(f.directory, "saved-jj"));
  success(["list"]);
  failure(["create", "task", "--vcs", "jj", "--no-open"], "not_jj");
  expect(existsSync(join(f.repo, ".jj"))).toBe(false);
});

test("undefined trunk fails without fetch or fallback", () => {
  f.commands.jj(f.repo, [
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    "absent_bookmark",
  ]);
  failure(["create", "task", "--no-open"], "state_conflict");
  expect(existsSync(f.path("task"))).toBe(false);
  expect(f.calls()).toEqual([]);
});

test("status is last-snapshot, never silently snapshots; explicit snapshot updates it", () => {
  const before = success(["status"]);
  writeFileSync(join(f.repo, "new.txt"), "unsnapshotted");
  expect(success(["status"])).toEqual(before);
  expect(success(["status", "--snapshot"])).toMatchObject({
    result: { files: 1, source: "snapshot-now" },
  });
  expect(success(["status"])).toMatchObject({
    result: { files: 1, source: "last-snapshot" },
  });
});

test("cleanup preview does not snapshot, move or forget", () => {
  create();
  writeFileSync(join(f.path("task"), "new.txt"), "unsnapshotted");
  const before = f.commands.jj(f.repo, ["workspace", "list"]);
  expect(success(["cleanup", "task"])).toMatchObject({
    result: { phase: "preview", untracked: 1, confirmation: f.path("task") },
  });
  expect(f.commands.jj(f.repo, ["workspace", "list"])).toBe(before);
  expect(existsSync(f.path("task"))).toBe(true);
});

test("cleanup protects primary and requires exact path confirmation", () => {
  failure(["cleanup", "default", "--confirm", f.repo], "unsafe_cleanup");
  create();
  failure(["cleanup", "task", "--confirm", "yes"], "invalid_input");
  expect(existsSync(f.path("task"))).toBe(true);
});

test("cleanup refuses ignored files, including local secret files, without opening contents", () => {
  create();
  writeFileSync(join(f.path("task"), ".gitignore"), ".env\nlocal.db\n");
  writeFileSync(join(f.path("task"), ".env"), "fixture-only-placeholder");
  writeFileSync(join(f.path("task"), "local.db"), "fixture database");
  failure(["cleanup", "task", "--confirm", f.path("task")], "unsafe_cleanup");
  expect(existsSync(join(f.path("task"), ".env"))).toBe(true);
  expect(existsSync(join(f.path("task"), "local.db"))).toBe(true);
});

test("cleanup refuses unsnapshotted files too large for jj, leaving checkout intact", () => {
  create();
  writeFileSync(
    join(f.path("task"), "large.bin"),
    new Uint8Array(2 * 1024 * 1024),
  );
  failure(["cleanup", "task", "--confirm", f.path("task")], "unsafe_cleanup");
  expect(existsSync(join(f.path("task"), "large.bin"))).toBe(true);
});

test("cleanup refuses an idle Herdr agent; never closes its pane", () => {
  create();
  f.control({
    panes: [
      {
        pane_id: "w9:p1",
        workspace_id: "w9",
        cwd: f.path("task"),
        foreground_cwd: f.path("task"),
        agent: "pi",
      },
    ],
  });
  failure(["cleanup", "task", "--confirm", f.path("task")], "unsafe_cleanup");
  expect(f.calls()).toEqual([["pane", "list"]]);
});

test("cleanup fails closed when Herdr safety inventory is unavailable", () => {
  create();
  f.control({ failHerdr: true });
  failure(["cleanup", "task", "--confirm", f.path("task")], "command_failed");
  expect(existsSync(f.path("task"))).toBe(true);
});

test("cleanup detects a real background process outside Herdr", async () => {
  create();
  const child = spawn(
    process.execPath,
    ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
    { cwd: f.path("task"), stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve) =>
    child.stdout?.once("data", () => resolve()),
  );
  try {
    failure(["cleanup", "task", "--confirm", f.path("task")], "unsafe_cleanup");
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
  expect(existsSync(f.path("task"))).toBe(true);
});

test("cleanup snapshots tracked and new files, pins recovery, archives without deleting", () => {
  create();
  writeFileSync(join(f.path("task"), "hello.txt"), "important edit\n");
  writeFileSync(join(f.path("task"), "new.txt"), "important addition\n");
  const receipt = cleanupReceipt(
    success(["cleanup", "task", "--confirm", f.path("task")]),
  );
  expect(receipt.phase).toBe("archived");
  expect(existsSync(f.path("task"))).toBe(false);
  expect(readFileSync(join(receipt.archive, "hello.txt"), "utf8")).toBe(
    "important edit\n",
  );
  expect(readFileSync(join(receipt.archive, "new.txt"), "utf8")).toBe(
    "important addition\n",
  );
  expect(
    f.commands.jj(f.repo, ["workspace", "list", "-T", 'name ++ "\n"']).trim(),
  ).toBe("default");
  expect(
    f.commands.jj(f.repo, [
      "file",
      "show",
      "-r",
      receipt.bookmark,
      "hello.txt",
    ]),
  ).toBe("important edit\n");
  expect(
    cleanupReceipt(success(["cleanup", "task", "--confirm", f.path("task")])),
  ).toEqual(receipt);
  failure(["create", "task", "--no-open"], "state_conflict");
});

test("cleanup can resume after move succeeds but jj forget fails", () => {
  create();
  f.control({ failForget: true });
  failure(
    ["cleanup", "task", "--confirm", f.path("task")],
    "partial_operation",
  );
  expect(existsSync(f.path("task"))).toBe(false);
  f.control({});
  const receipt = cleanupReceipt(
    success(["cleanup", "task", "--confirm", f.path("task")]),
  );
  expect(existsSync(join(receipt.archive, "hello.txt"))).toBe(true);
  expect(receipt.phase).toBe("archived");
});

test("cleanup refuses symlink path substitution", () => {
  create();
  const moved = join(f.directory, "moved");
  renameSync(f.path("task"), moved);
  symlinkSync(moved, f.path("task"));
  failure(["cleanup", "task", "--confirm", f.path("task")], "state_conflict");
  expect(readFileSync(join(moved, "hello.txt"), "utf8")).toBe("trunk\n");
});
