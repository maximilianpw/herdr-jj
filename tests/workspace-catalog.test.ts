import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
function list() {
  return parse(
    z.object({
      result: z.object({
        workspaces: z.array(
          z.object({
            kind: z.enum(["jj", "git"]),
            name: z.string(),
            path: z.string().nullable(),
          }),
        ),
      }),
    }),
    success(["list"]),
    "workspace list",
  ).result.workspaces;
}
function gitOnly() {
  renameSync(join(f.repo, ".jj"), join(f.directory, "saved-jj"));
}

test("one inventory includes JJ and Git workspaces, counting colocated checkouts once", () => {
  success(["create", "jj-task", "--no-open"]);
  const gitPath = `${f.repo}.git-existing`;
  f.commands.git(f.repo, [
    "worktree",
    "add",
    "-b",
    "feature/existing",
    gitPath,
    "main",
  ]);
  expect(list()).toEqual([
    { kind: "jj", name: "default", path: f.repo },
    { kind: "jj", name: "jj-task", path: f.path("jj-task") },
    { kind: "git", name: "feature/existing", path: gitPath },
  ]);
  success(["open", "feature/existing"]);
  expect(f.calls()).toContainEqual([
    "worktree",
    "open",
    "--cwd",
    f.repo,
    "--path",
    gitPath,
    "--label",
    "git: feature/existing",
    "--no-focus",
  ]);
});

test("explicit Git creation in a JJ repo keeps source edits and JJ history unchanged", () => {
  writeFileSync(join(f.repo, "local.txt"), "not committed");
  const before = f.commands.jj(f.repo, [
    "op",
    "log",
    "--limit",
    "1",
    "--no-graph",
    "-T",
    "id",
  ]);
  const path = `${f.repo}.git-git-task`;
  expect(
    success([
      "create",
      "git-task",
      "--vcs",
      "git",
      "--base",
      "main",
      "--no-open",
    ]),
  ).toMatchObject({
    result: { workspace: { kind: "git", name: "git-task", path } },
  });
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(existsSync(join(path, ".jj"))).toBe(false);
  expect(existsSync(join(path, "local.txt"))).toBe(false);
  expect(readFileSync(join(f.repo, "local.txt"), "utf8")).toBe("not committed");
  expect(
    f.commands.jj(f.repo, [
      "op",
      "log",
      "--limit",
      "1",
      "--no-graph",
      "-T",
      "id",
    ]),
  ).toBe(before);
  expect(f.commands.git(path, ["branch", "--show-current"]).trim()).toBe(
    "git-task",
  );
  success([
    "create",
    "git-task",
    "--vcs",
    "git",
    "--base",
    "main",
    "--no-open",
  ]);
  expect(list().filter((entry) => entry.path === path)).toHaveLength(1);
});

test.each([
  "maximilianpw/vev-1113-fix-pool-vehicle-translation-and-pool_car-key-reuse",
  "feature/release.v1+fix_é",
  "_task",
  "a".repeat(180),
  Array.from({ length: 5 }, (_, i) => `${i}-${"b".repeat(90)}`).join("/"),
])("Git creation preserves the full branch name: %s", (name) => {
  const args = ["create", name, "--vcs", "git", "--no-open"];
  success(args);
  const workspace = list().find((entry) => entry.name === name);
  expect(workspace?.kind).toBe("git");
  if (!workspace?.path) throw new Error("Missing Git checkout");
  expect(dirname(workspace.path)).toBe(dirname(f.repo));
  expect(
    f.commands.git(workspace.path, ["branch", "--show-current"]).trim(),
  ).toBe(name);
  success(args);
  expect(list().filter((entry) => entry.name === name)).toHaveLength(1);
  success(["open", name, "--vcs", "git"]);
  expect(f.calls()).toContainEqual([
    "worktree",
    "open",
    "--cwd",
    f.repo,
    "--path",
    workspace.path,
    "--label",
    `git: ${name}`,
    "--no-focus",
  ]);
});

test("slash and percent branch names have distinct checkout paths and journals", () => {
  for (const name of ["feature/task", "feature%2Ftask", "feature_task"]) {
    success(["create", name, "--vcs", "git", "--no-open"]);
    success(["create", name, "--vcs", "git", "--no-open"]);
  }
  const paths = list()
    .filter((entry) => entry.kind === "git")
    .map((entry) => entry.path);
  expect(new Set(paths).size).toBe(3);
});

test.each([
  "bad name",
  "bad..name",
  "../escape",
  "bad:name",
  "bad~name",
  "bad.lock",
  "bad//name",
  "@{-1}",
])(
  "Git-invalid names are rejected before writing a creation receipt: %s",
  (name) => {
    const before = list();
    const result = f.cli(["create", name, "--vcs", "git", "--no-open"]);
    expect(result.status).toBe(1);
    expect(result.json()).toMatchObject({ error: { code: "invalid_input" } });
    expect(list()).toEqual(before);
    expect(
      readdirSync(f.state, { recursive: true, encoding: "utf8" }).filter(
        (entry) => entry.endsWith(".json"),
      ),
    ).toEqual([]);
  },
);

test("Git-only repositories default to Git creation and never initialize JJ", () => {
  gitOnly();
  expect(success(["create", "task", "--no-open"])).toMatchObject({
    result: { workspace: { kind: "git", name: "task" } },
  });
  expect(existsSync(join(f.repo, ".jj"))).toBe(false);
  expect(existsSync(join(`${f.repo}.git-task`, ".jj"))).toBe(false);
  expect(list().every((entry) => entry.kind === "git")).toBe(true);
  success(["open", "task", "--vcs", "git"]);
  const refused = f.cli(["create", "jj-task", "--vcs", "jj", "--no-open"]);
  expect(refused.status).toBe(1);
  expect(refused.json()).toMatchObject({ error: { code: "not_jj" } });
});

test("name ambiguity requires a VCS selector or exact checkout path", () => {
  success(["create", "task", "--no-open"]);
  success(["create", "task", "--vcs", "git", "--no-open"]);
  const ambiguous = f.cli(["open", "task"]);
  expect(ambiguous.status).toBe(1);
  expect(ambiguous.json()).toMatchObject({ error: { code: "invalid_input" } });
  success(["open", "task", "--vcs", "jj"]);
  success(["open", `${f.repo}.git-task`]);
});

test("failed Herdr opening retains Git checkout and supports exact retry", () => {
  f.control({ failOpen: true });
  const failed = f.cli(["create", "task", "--vcs", "git"]);
  expect(failed.status).toBe(1);
  expect(failed.json()).toMatchObject({ error: { code: "partial_operation" } });
  expect(existsSync(`${f.repo}.git-task`)).toBe(true);
  f.control({});
  success(["create", "task", "--vcs", "git"]);
  success(["open", "task", "--vcs", "git"]);
  expect(list().filter((entry) => entry.name === "task")).toHaveLength(1);
});

test("existing Git branches and invalid bases are never overwritten or guessed", () => {
  f.commands.git(f.repo, ["branch", "occupied", "main"]);
  const original = f.commands.git(f.repo, ["rev-parse", "occupied"]);
  expect(
    f.cli(["create", "occupied", "--vcs", "git", "--no-open"]).status,
  ).toBe(1);
  expect(f.commands.git(f.repo, ["rev-parse", "occupied"])).toBe(original);
  expect(existsSync(`${f.repo}.git-occupied`)).toBe(false);
  expect(
    f.cli([
      "create",
      "invalid",
      "--vcs",
      "git",
      "--base",
      "no-such-ref",
      "--no-open",
    ]).status,
  ).toBe(1);
  expect(existsSync(`${f.repo}.git-invalid`)).toBe(false);
});

test("opening a Git workspace preserves dirty files and refuses stale paths", () => {
  success(["create", "task", "--vcs", "git", "--no-open"]);
  const path = `${f.repo}.git-task`;
  writeFileSync(join(path, "hello.txt"), "local Git edits");
  writeFileSync(join(path, "new.txt"), "untracked work");
  success(["open", "task"]);
  expect(readFileSync(join(path, "hello.txt"), "utf8")).toBe("local Git edits");
  expect(readFileSync(join(path, "new.txt"), "utf8")).toBe("untracked work");
  expect(f.cli(["cleanup", "task", "--confirm", path]).status).toBe(1);
  expect(existsSync(path)).toBe(true);
  renameSync(path, `${path}-moved`);
  expect(f.cli(["open", "task"]).status).toBe(1);
});

test("a Git-only sibling discovers JJ but cannot continue an unrelated JJ current change", () => {
  success(["create", "git-task", "--vcs", "git", "--no-open"]);
  const path = `${f.repo}.git-git-task`;
  const refused = f.cli(
    ["create", "followup", "--base", "current", "--no-open"],
    {},
    path,
  );
  expect(refused.status).toBe(1);
  expect(refused.json()).toMatchObject({ error: { code: "invalid_input" } });
  expect(existsSync(f.path("followup"))).toBe(false);
  expect(f.cli(["create", "followup", "--no-open"], {}, path).status).toBe(0);
});

test("archived JJ checkouts never reappear as active Git workspaces", () => {
  success(["create", "task", "--no-open"]);
  success(["cleanup", "task", "--confirm", f.path("task")]);
  expect(list()).toEqual([{ kind: "jj", name: "default", path: f.repo }]);
});
