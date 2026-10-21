import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Fixture, fixture } from "./fixtures";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});

function create() {
  const created = f.cli(["create", "task", "--no-open"]);
  expect(created.status).toBe(0);
}
function cleanupFails() {
  const result = f.cli(["cleanup", "task", "--confirm", f.path("task")]);
  expect(result.status).toBe(1);
  expect(result.json()).toMatchObject({ error: { code: "unsafe_cleanup" } });
  expect(existsSync(f.path("task"))).toBe(true);
}

test("cleanup rejects a missing or broken lsof instead of assuming idle", () => {
  create();
  writeFileSync(join(f.bin, "lsof"), "#!/bin/sh\nexit 2\n");
  chmodSync(join(f.bin, "lsof"), 0o755);
  cleanupFails();
});

test("cleanup refuses an archive directory redirected through a symlink", () => {
  create();
  const elsewhere = join(f.directory, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, `${f.repo}.jj-archives`);
  cleanupFails();
});

test("cleanup preserves a conflicting workspace and status exposes the conflict", () => {
  writeFileSync(join(f.repo, "hello.txt"), "left\n");
  f.commands.jj(f.repo, ["describe", "-m", "left"], true);
  const left = f.commands.jj(f.repo, [
    "log",
    "--no-graph",
    "-r",
    "@",
    "-T",
    "commit_id",
  ]);
  f.commands.jj(f.repo, ["new", "main"], true);
  writeFileSync(join(f.repo, "hello.txt"), "right\n");
  f.commands.jj(f.repo, ["describe", "-m", "right"], true);
  const right = f.commands.jj(f.repo, [
    "log",
    "--no-graph",
    "-r",
    "@",
    "-T",
    "commit_id",
  ]);
  f.commands.jj(f.repo, ["new", left, right], true);
  expect(f.cli(["status"]).json()).toMatchObject({
    result: { conflict: true },
  });
  expect(
    f.cli(["create", "task", "--base", "current", "--no-open"]).status,
  ).toBe(0);
  cleanupFails();
});
