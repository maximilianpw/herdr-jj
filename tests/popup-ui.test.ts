import { expect, test } from "bun:test";
import type { Key } from "node:readline";
import { InputDialog, WorkspaceForm, WorkspacePicker } from "../src/popup-ui";

function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, ...extra };
}
function type(
  dialog: { handleKey(text: string | undefined, key: Key): unknown },
  text: string,
) {
  for (const char of text) dialog.handleKey(char, key(char));
}
function plain(
  dialog: { render(width: number, height: number): { lines: string[] } },
  width = 66,
  height = 16,
) {
  return dialog.render(width, height).lines.map(Bun.stripANSI).join("\n");
}
const options = {
  primary: "/repo/project",
  allowJj: true,
  allowCurrentJj: true,
};

test("creation is a single native-style form with a live checkout preview", () => {
  const form = new WorkspaceForm(options);
  type(form, "task");
  const frame = plain(form);
  expect(frame).toContain("type");
  expect(frame).toContain("JJ");
  expect(frame).toContain("Git");
  expect(frame).toContain("name");
  expect(frame).toContain("base");
  expect(frame).toContain("checkout");
  expect(frame).toContain("/repo/project.jj-task");
  expect(frame).toContain("↵ create and open");
  expect(form.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: { name: "task", kind: "jj", base: "trunk" },
  });
});

test("Tab and arrows change type and base without extra wizard screens", () => {
  const form = new WorkspaceForm(options);
  type(form, "git-task");
  form.handleKey(undefined, key("tab", { shift: true }));
  form.handleKey(undefined, key("right"));
  expect(plain(form)).toContain("/repo/project.git-git-task");
  form.handleKey(undefined, key("tab"));
  form.handleKey(undefined, key("tab"));
  form.handleKey(undefined, key("u", { ctrl: true }));
  type(form, "main");
  expect(form.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: { name: "git-task", kind: "git", base: "main" },
  });
});

test("invalid names stay in the form; cancellation never submits", () => {
  const form = new WorkspaceForm(options);
  type(form, "bad/name");
  expect(form.handleKey(undefined, key("return"))).toBeUndefined();
  expect(plain(form)).toContain("Invalid workspace name");
  expect(form.handleKey(undefined, key("escape"))).toEqual({ type: "cancel" });
});

test("Git-only forms cannot choose JJ; continuation is unavailable from Git siblings", () => {
  const git = new WorkspaceForm({ ...options, allowJj: false });
  type(git, "task");
  expect(git.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: { name: "task", kind: "git", base: "HEAD" },
  });
  const jj = new WorkspaceForm({ ...options, allowCurrentJj: false });
  type(jj, "task");
  jj.handleKey(undefined, key("tab"));
  jj.handleKey(undefined, key("right"));
  expect(jj.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: { name: "task", kind: "jj", base: "trunk" },
  });
});

const entries = [
  { id: "one", name: "shared", path: "/repo/jj-task", kind: "jj" as const },
  { id: "two", name: "shared", path: "/repo/git-task", kind: "git" as const },
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `other-${index}`,
    name: `task-${index}`,
    path: `/repo/long/workspace-${index}`,
    kind: "git" as const,
  })),
];

test("picker searches names and paths, preserves identity, and shows result counts", () => {
  const picker = new WorkspacePicker("open workspace", entries, "open");
  expect(plain(picker)).toContain("22 workspaces");
  picker.handleKey("/", key("/"));
  type(picker, "git-task");
  expect(plain(picker)).toContain("1/22 workspaces");
  expect(picker.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: "two",
  });
});

test("no-match search cannot accidentally open a workspace; Esc clears search before closing", () => {
  const picker = new WorkspacePicker("open workspace", entries, "open");
  type(picker, "missing");
  expect(plain(picker)).toContain("No matching workspaces");
  expect(picker.handleKey(undefined, key("return"))).toBeUndefined();
  expect(picker.handleKey(undefined, key("escape"))).toBeUndefined();
  expect(plain(picker)).toContain("22 workspaces");
  expect(picker.handleKey(undefined, key("escape"))).toEqual({
    type: "cancel",
  });
});

test("long picker lists scroll with selection and fit resized windows", () => {
  const picker = new WorkspacePicker("open workspace", entries, "open");
  picker.render(42, 10);
  picker.handleKey(undefined, key("end"));
  const frame = picker.render(42, 10);
  expect(frame.lines).toHaveLength(10);
  expect(frame.lines.map(Bun.stripANSI).join("\n")).toContain("task-19");
  for (const line of frame.lines)
    expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(42);
});

test("input supports cursor editing and strips terminal control characters from display", () => {
  const input = new InputDialog(
    "confirm archive",
    ["unsafe\u001b[2J path"],
    "archive",
  );
  type(input, "ac");
  input.handleKey(undefined, key("left"));
  type(input, "b");
  expect(input.handleKey(undefined, key("return"))).toEqual({
    type: "submit",
    value: "abc",
  });
  expect(plain(input)).not.toContain("\u001b[2J");
});
