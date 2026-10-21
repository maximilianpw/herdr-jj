import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { z } from "zod";
import { PluginError } from "./command";
import { workspaceName } from "./repository";
import type { WorkspaceKind } from "./workspace-catalog";

const themeSchema = z.object({
  theme: z
    .object({
      name: z.string().optional(),
      custom: z
        .object({
          panel_bg: z.string().optional(),
          text: z.string().optional(),
          muted: z.string().optional(),
          accent: z.string().optional(),
          selection_bg: z.string().optional(),
          red: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

type PopupTheme = {
  panel: string;
  text: string;
  muted: string;
  accent: string;
  input: string;
  error: string;
};
const catppuccin: PopupTheme = {
  panel: "#181825",
  text: "#cdd6f4",
  muted: "#6c7086",
  accent: "#89b4fa",
  input: "#313244",
  error: "#f38ba8",
};

export function readPopupTheme(): PopupTheme {
  // Native plugin panes do not receive Herdr's resolved palette. Match the
  // configured Catppuccin/custom colors; other themes use terminal ANSI colors.
  let config: z.infer<typeof themeSchema>;
  try {
    config = themeSchema.parse(
      Bun.TOML.parse(
        readFileSync(
          process.env.HERDR_CONFIG_PATH ??
            join(homedir(), ".config", "herdr", "config.toml"),
          "utf8",
        ),
      ),
    );
  } catch {
    return catppuccin;
  }
  const defaults =
    !config.theme?.name || config.theme.name === "catppuccin"
      ? catppuccin
      : {
          panel: "default",
          text: "default",
          muted: "8",
          accent: "4",
          input: "8",
          error: "1",
        };
  const custom = config.theme?.custom;
  return {
    panel: custom?.panel_bg ?? defaults.panel,
    text: custom?.text ?? defaults.text,
    muted: custom?.muted ?? defaults.muted,
    accent: custom?.accent ?? defaults.accent,
    input: custom?.selection_bg ?? defaults.input,
    error: custom?.red ?? defaults.error,
  };
}

type DialogResult<T> = { type: "submit"; value: T } | { type: "cancel" };
type Frame = { lines: string[]; cursor?: { x: number; y: number } };
interface Dialog<T> {
  render(width: number, height: number): Frame;
  handleKey(text: string | undefined, key: Key): DialogResult<T> | undefined;
}

function safeText(text: string): string {
  return text.replace(/\p{Cc}/gu, " ");
}
function fit(text: string, width: number): string {
  const clean = safeText(text);
  if (width <= 0) return "";
  if (Bun.stringWidth(clean) <= width) return clean;
  let out = "";
  for (const char of clean) {
    if (Bun.stringWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}
function pad(text: string, width: number): string {
  const value = fit(text, width);
  return value + " ".repeat(Math.max(0, width - Bun.stringWidth(value)));
}
function pair(left: string, right: string, width: number): string {
  const suffix = fit(right, Math.max(0, Math.floor(width / 2)));
  return pad(left, Math.max(0, width - Bun.stringWidth(suffix))) + suffix;
}
function color(value: string, background = false): string {
  const short = /^#([a-f0-9]{3})$/i.exec(value)?.[1];
  const hex = short
    ? Array.from(short, (char) => char + char).join("")
    : /^#([a-f0-9]{6})$/i.exec(value)?.[1];
  if (hex)
    return `${background ? 48 : 38};2;${Number.parseInt(hex.slice(0, 2), 16)};${Number.parseInt(hex.slice(2, 4), 16)};${Number.parseInt(hex.slice(4, 6), 16)}`;
  if (/^\d{1,2}$/.test(value) && Number(value) < 16)
    return `${background ? 48 : 38};5;${value}`;
  return background ? "49" : "39";
}
function styled(
  text: string,
  foreground: string,
  background: string,
  bold = false,
): string {
  return `\x1b[0;${color(foreground)};${color(background, true)}${bold ? ";1" : ""}m${text}\x1b[0m`;
}
function canvas(width: number, height: number, theme: PopupTheme) {
  const frame: Frame = {
    lines: Array.from({ length: height }, () =>
      styled(" ".repeat(width), theme.text, theme.panel),
    ),
  };
  const row = (
    y: number,
    text: string,
    foreground = theme.text,
    background = theme.panel,
    bold = false,
  ) => {
    if (y >= 0 && y < height)
      frame.lines[y] = styled(pad(text, width), foreground, background, bold);
  };
  const footer = (label: string, enabled = true) => {
    const primary = ` ↵ ${label} `;
    const cancel = " esc cancel ";
    const length = Bun.stringWidth(primary + cancel) + 2;
    if (length > width) {
      row(height - 1, `↵ ${label} · esc cancel`, theme.muted);
      return;
    }
    const before = Math.floor((width - length) / 2);
    frame.lines[height - 1] =
      styled(" ".repeat(before), theme.text, theme.panel) +
      styled(
        primary,
        enabled ? theme.panel : theme.muted,
        enabled ? theme.accent : theme.input,
        true,
      ) +
      styled("  ", theme.text, theme.panel) +
      styled(cancel, theme.text, theme.input, true) +
      styled(" ".repeat(width - before - length), theme.text, theme.panel);
  };
  return { frame, row, footer };
}

class TextInput {
  value: string;
  cursor: number;
  constructor(value = "") {
    this.value = value;
    this.cursor = Array.from(value).length;
  }
  edit(text: string | undefined, key: Key): void {
    const chars = Array.from(this.value);
    if (key.ctrl && key.name === "u") {
      chars.splice(0, this.cursor);
      this.cursor = 0;
    } else if ((key.ctrl && key.name === "a") || key.name === "home")
      this.cursor = 0;
    else if ((key.ctrl && key.name === "e") || key.name === "end")
      this.cursor = chars.length;
    else if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (key.name === "backspace" && this.cursor > 0)
      chars.splice(--this.cursor, 1);
    else if (key.name === "delete") chars.splice(this.cursor, 1);
    else if (text && !key.ctrl && !key.meta && safeText(text) === text) {
      const inserted = Array.from(text);
      chars.splice(this.cursor, 0, ...inserted);
      this.cursor += inserted.length;
    }
    this.value = chars.join("");
  }
  view(width: number): { text: string; cursor: number } {
    const chars = Array.from(this.value);
    let start = 0;
    while (
      start < this.cursor &&
      Bun.stringWidth(chars.slice(start, this.cursor).join("")) >=
        Math.max(1, width)
    )
      start++;
    return {
      text: fit(chars.slice(start).join(""), width),
      cursor: Bun.stringWidth(chars.slice(start, this.cursor).join("")),
    };
  }
}

export type WorkspaceDraft = {
  name: string;
  kind: WorkspaceKind;
  base: string;
};
type WorkspaceFormOptions = {
  primary: string;
  allowJj: boolean;
  allowCurrentJj: boolean;
};
export class WorkspaceForm implements Dialog<WorkspaceDraft> {
  private readonly name = new TextInput();
  private readonly gitBase = new TextInput("HEAD");
  private kind: WorkspaceKind;
  private jjBase: "trunk" | "current" = "trunk";
  private focus: "type" | "name" | "base" = "name";
  private error = "";
  constructor(
    private readonly options: WorkspaceFormOptions,
    private readonly theme = catppuccin,
  ) {
    this.kind = options.allowJj ? "jj" : "git";
  }
  handleKey(
    text: string | undefined,
    key: Key,
  ): DialogResult<WorkspaceDraft> | undefined {
    if (key.name === "escape" || (key.ctrl && key.name === "c"))
      return { type: "cancel" };
    if (key.name === "return") {
      try {
        const name = workspaceName(this.name.value);
        if (this.kind === "git" && !this.gitBase.value.trim())
          throw new PluginError("invalid_input", "Git base is required.");
        return {
          type: "submit",
          value: {
            name,
            kind: this.kind,
            base: this.kind === "jj" ? this.jjBase : this.gitBase.value,
          },
        };
      } catch (cause) {
        if (!(cause instanceof PluginError)) throw cause;
        this.error = cause.message;
        return;
      }
    }
    if (key.name === "tab") {
      const fields: (typeof this.focus)[] = this.options.allowJj
        ? ["type", "name", "base"]
        : ["name", "base"];
      const next =
        (fields.indexOf(this.focus) + (key.shift ? fields.length - 1 : 1)) %
        fields.length;
      this.focus = fields[next] ?? "name";
    } else if (this.focus === "type") {
      if (
        ["left", "right", "up", "down", "space"].includes(key.name ?? "") &&
        this.options.allowJj
      )
        this.kind = this.kind === "jj" ? "git" : "jj";
    } else if (this.focus === "base" && this.kind === "jj") {
      if (
        ["left", "right", "up", "down", "space"].includes(key.name ?? "") &&
        this.options.allowCurrentJj
      )
        this.jjBase = this.jjBase === "trunk" ? "current" : "trunk";
    } else {
      (this.focus === "name" ? this.name : this.gitBase).edit(text, key);
      this.error = "";
    }
  }
  render(width: number, height: number): Frame {
    const { frame, row, footer } = canvas(width, height, this.theme);
    const compact = height < 14;
    const nameRow = compact ? 2 : 3;
    const baseRow = compact ? 4 : 6;
    const pathRow = compact ? 6 : 9;
    row(
      0,
      ` type   ${this.kind === "jj" ? "[ JJ ]   Git" : this.options.allowJj ? "JJ   [ Git ]" : "[ Git ]"}`,
      this.theme.text,
      this.focus === "type" ? this.theme.input : this.theme.panel,
    );
    row(
      nameRow - 1,
      this.kind === "git" ? " branch / workspace name" : " name",
      this.theme.muted,
    );
    const name = this.name.view(Math.max(1, width - 2));
    row(
      nameRow,
      ` ${name.text || "workspace-name"}`,
      name.text ? this.theme.text : this.theme.muted,
      this.focus === "name" ? this.theme.input : this.theme.panel,
    );
    row(baseRow - 1, " base", this.theme.muted);
    const base = this.gitBase.view(Math.max(1, width - 2));
    row(
      baseRow,
      this.kind === "git"
        ? ` ${base.text}`
        : ` ${this.jjBase === "trunk" ? "[ trunk ]" : "trunk"}${this.options.allowCurrentJj ? (this.jjBase === "current" ? "   [ current change ]" : "   current change") : ""}`,
      this.theme.text,
      this.focus === "base" ? this.theme.input : this.theme.panel,
    );
    row(pathRow - 1, " checkout", this.theme.muted);
    row(
      pathRow,
      ` ${this.options.primary}.${this.kind}-${this.name.value || "<name>"}`,
      this.theme.muted,
    );
    row(
      height - 3,
      this.error
        ? ` ${this.error}`
        : this.kind === "git"
          ? " Committed history only; source edits stay here."
          : " New JJ change; source is snapshotted.",
      this.error ? this.theme.error : this.theme.muted,
    );
    row(
      height - 2,
      " tab next field   ←/→ choose   shift-tab previous",
      this.theme.muted,
    );
    footer("create and open", Boolean(this.name.value));
    if (this.focus === "name")
      frame.cursor = { x: 1 + name.cursor, y: nameRow };
    if (this.focus === "base" && this.kind === "git")
      frame.cursor = { x: 1 + base.cursor, y: baseRow };
    return frame;
  }
}

export type WorkspaceChoice = {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceKind;
  current?: boolean;
};
export class WorkspacePicker implements Dialog<string> {
  private readonly query = new TextInput();
  private searching = false;
  private selected = 0;
  private visibleCount = 4;
  constructor(
    private readonly title: string,
    private readonly choices: WorkspaceChoice[],
    private readonly submitLabel: string,
    private readonly theme = catppuccin,
  ) {}
  private matches(): WorkspaceChoice[] {
    const words = this.query.value
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return this.choices.filter((choice) =>
      words.every((word) =>
        `${choice.name} ${choice.path} ${choice.kind}`
          .toLowerCase()
          .includes(word),
      ),
    );
  }
  handleKey(
    text: string | undefined,
    key: Key,
  ): DialogResult<string> | undefined {
    if (key.ctrl && key.name === "c") return { type: "cancel" };
    if (key.name === "escape") {
      if (this.query.value || this.searching) {
        this.query.value = "";
        this.query.cursor = 0;
        this.selected = 0;
        this.searching = false;
        return;
      }
      return { type: "cancel" };
    }
    const matches = this.matches();
    if (key.name === "return") {
      const choice = matches[this.selected];
      return choice ? { type: "submit", value: choice.id } : undefined;
    }
    if (
      key.name === "up" ||
      key.name === "down" ||
      key.name === "pageup" ||
      key.name === "pagedown"
    ) {
      const delta =
        key.name === "up"
          ? -1
          : key.name === "down"
            ? 1
            : key.name === "pageup"
              ? -this.visibleCount
              : this.visibleCount;
      this.selected = Math.max(
        0,
        Math.min(matches.length - 1, this.selected + delta),
      );
    } else if (!this.searching && (key.name === "home" || key.name === "end")) {
      this.selected = key.name === "home" ? 0 : Math.max(0, matches.length - 1);
    } else if (text === "/" && !this.searching) {
      this.searching = true;
    } else {
      const before = this.query.value;
      this.query.edit(text, key);
      if (this.query.value !== before) {
        this.searching = true;
        this.selected = 0;
      }
    }
  }
  render(width: number, height: number): Frame {
    const { frame, row, footer } = canvas(width, height, this.theme);
    const matches = this.matches();
    this.visibleCount = Math.max(1, Math.floor((height - 6) / 2));
    const count = `${this.query.value ? `${matches.length}/` : ""}${this.choices.length} workspaces`;
    row(0, ` ${this.title}`, this.theme.text, this.theme.panel, true);
    const query = this.query.view(Math.max(1, width - count.length - 5));
    row(
      1,
      pair(
        ` / ${this.searching ? query.text : "filter workspaces"}`,
        count,
        width,
      ),
      this.theme.muted,
    );
    row(2, "─".repeat(width), this.theme.muted);
    const start = Math.max(
      0,
      Math.min(
        this.selected - this.visibleCount + 1,
        Math.max(0, matches.length - this.visibleCount),
      ),
    );
    for (
      let index = start;
      index < Math.min(matches.length, start + this.visibleCount);
      index++
    ) {
      const choice = matches[index];
      if (!choice) continue;
      const selected = index === this.selected;
      const foreground = selected ? this.theme.panel : this.theme.text;
      const background = selected ? this.theme.accent : this.theme.panel;
      const y = 3 + (index - start) * 2;
      row(
        y,
        pair(
          ` ${choice.name}`,
          `${choice.kind.toUpperCase()}${choice.current ? " · current" : ""} `,
          width,
        ),
        foreground,
        background,
        true,
      );
      row(
        y + 1,
        ` ${choice.path}`,
        selected ? this.theme.panel : this.theme.muted,
        background,
      );
    }
    if (!matches.length) row(3, " No matching workspaces", this.theme.muted);
    row(
      height - 2,
      " ↑/↓ select   / filter   pgup/pgdn scroll",
      this.theme.muted,
    );
    footer(this.submitLabel, matches.length > 0);
    if (this.searching) frame.cursor = { x: 3 + query.cursor, y: 1 };
    return frame;
  }
}

export class InputDialog implements Dialog<string> {
  private readonly input = new TextInput();
  constructor(
    private readonly title: string,
    private readonly details: string[],
    private readonly submitLabel: string,
    private readonly theme = catppuccin,
  ) {}
  handleKey(
    text: string | undefined,
    key: Key,
  ): DialogResult<string> | undefined {
    if (key.name === "escape" || (key.ctrl && key.name === "c"))
      return { type: "cancel" };
    if (key.name === "return")
      return { type: "submit", value: this.input.value };
    this.input.edit(text, key);
  }
  render(width: number, height: number): Frame {
    const { frame, row, footer } = canvas(width, height, this.theme);
    row(0, ` ${this.title}`, this.theme.text, this.theme.panel, true);
    let y = 2;
    for (const detail of this.details) {
      const chars = Array.from(safeText(detail));
      let line = "";
      for (const char of chars) {
        if (Bun.stringWidth(line + char) > Math.max(1, width - 2)) {
          row(y++, ` ${line}`, this.theme.muted);
          line = "";
        }
        line += char;
        if (y >= height - 4) break;
      }
      if (y < height - 4) row(y++, ` ${line}`, this.theme.muted);
    }
    const view = this.input.view(Math.max(1, width - 2));
    row(height - 3, ` ${view.text}`, this.theme.text, this.theme.input);
    frame.cursor = { x: view.cursor + 1, y: height - 3 };
    footer(this.submitLabel);
    return frame;
  }
}

export async function runDialog<T>(dialog: Dialog<T>): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new PluginError(
      "invalid_input",
      "Popup requires a terminal. Use the CLI for noninteractive work.",
    );
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const render = () => {
    const frame = dialog.render(
      Math.max(1, process.stdout.columns),
      Math.max(1, process.stdout.rows),
    );
    let output = "\x1b[?2026h\x1b[?25l\x1b[?7l";
    for (const [y, line] of frame.lines.entries())
      output += `\x1b[${y + 1};1H${line}`;
    if (frame.cursor)
      output += `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H\x1b[?25h`;
    process.stdout.write(`${output}\x1b[?7h\x1b[?2026l`);
  };
  let onKey: (text: string | undefined, key: Key) => void = () => {};
  let onResize = () => {};
  let active = true;
  try {
    return await new Promise<T>((resolve, reject) => {
      let renderQueued = false;
      const requestRender = () => {
        if (renderQueued || !active) return;
        renderQueued = true;
        queueMicrotask(() => {
          renderQueued = false;
          if (!active) return;
          try {
            render();
          } catch (cause) {
            active = false;
            reject(cause);
          }
        });
      };
      onResize = requestRender;
      onKey = (text, key) => {
        try {
          const result = dialog.handleKey(text, key);
          if (!result) {
            requestRender();
            return;
          }
          active = false;
          process.stdin.off("keypress", onKey);
          if (result.type === "cancel")
            reject(
              new PluginError(
                "cancelled",
                "Popup cancelled. No operation was started.",
              ),
            );
          else resolve(result.value);
        } catch (cause) {
          active = false;
          process.stdin.off("keypress", onKey);
          reject(cause);
        }
      };
      process.stdin.on("keypress", onKey);
      process.stdout.on("resize", onResize);
      render();
    });
  } finally {
    active = false;
    process.stdin.off("keypress", onKey);
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?2026l");
  }
}
