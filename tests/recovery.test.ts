import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Fixture, fixture } from "./fixtures";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});

test("new tasks get a full checkout even when the source is sparse", () => {
  f.commands.jj(f.repo, ["sparse", "set", "--clear"], true);
  expect(existsSync(join(f.repo, "hello.txt"))).toBe(false);
  expect(f.cli(["create", "task", "--no-open"]).status).toBe(0);
  expect(existsSync(join(f.path("task"), "hello.txt"))).toBe(true);
});

test("an invalid trunk is rejected before snapshotting the source", () => {
  f.commands.jj(f.repo, [
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    "missing_bookmark",
  ]);
  writeFileSync(join(f.repo, "unsnapshotted.txt"), "leave on disk");
  expect(f.cli(["create", "task", "--no-open"]).status).toBe(1);
  expect(f.commands.jj(f.repo, ["file", "list"])).not.toContain(
    "unsnapshotted.txt",
  );
});

test("prepared cleanup retry catches subsequent tracked edits", () => {
  expect(f.cli(["create", "task", "--no-open"]).status).toBe(0);
  f.commands.git(f.repo, ["worktree", "lock", f.path("task")]);
  const failed = f.cli(["cleanup", "task", "--confirm", f.path("task")]);
  expect(failed.json()).toMatchObject({
    error: { code: "partial_operation", retryable: true },
  });
  f.commands.git(f.repo, ["worktree", "unlock", f.path("task")]);
  writeFileSync(join(f.path("task"), "hello.txt"), "later tracked edit");
  const retry = f.cli(["cleanup", "task", "--confirm", f.path("task")]);
  expect(retry.json()).toMatchObject({
    error: { code: "state_conflict", retryable: false },
  });
  expect(existsSync(f.path("task"))).toBe(true);
});

test("cleanup recovery cannot forget a replacement workspace with the same name", () => {
  expect(f.cli(["create", "task", "--no-open"]).status).toBe(0);
  f.control({ failForget: true });
  expect(f.cli(["cleanup", "task", "--confirm", f.path("task")]).status).toBe(
    1,
  );
  f.control({});
  f.commands.jj(f.repo, ["workspace", "forget", "task"]);
  const replacement = join(f.directory, "replacement");
  f.commands.jj(
    f.repo,
    [
      "workspace",
      "add",
      "--colocate",
      "--name",
      "task",
      "-r",
      "main",
      replacement,
    ],
    true,
  );
  const retry = f.cli(["cleanup", "task", "--confirm", f.path("task")]);
  expect(retry.json()).toMatchObject({ error: { code: "state_conflict" } });
  expect(f.commands.jj(f.repo, ["workspace", "list"])).toContain("task:");
  expect(existsSync(replacement)).toBe(true);
});
