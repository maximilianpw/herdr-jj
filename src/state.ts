import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { PluginError, parse, parseJson } from "./command";
import { containsPath } from "./repository";

export class PluginState {
  readonly directory: string;

  constructor(directory: string, repositoryIdentity: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(repositoryIdentity)
      .digest("hex")
      .slice(0, 24);
    this.directory = join(realpathSync(directory), key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  read<T>(name: string, schema: z.ZodType<T>): T | undefined {
    const path = join(this.directory, `${name}.json`);
    if (!existsSync(path)) return undefined;
    return parse(schema, parseJson(readFileSync(path, "utf8")), "plugin state");
  }

  write(name: string, value: unknown): void {
    const path = join(this.directory, `${name}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  }

  withLock<T>(operation: () => T): T {
    const lock = join(this.directory, "lock");
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (cause) {
      throw new PluginError(
        "busy",
        `Repository operation is locked at ${lock}. Wait for the other plugin command; after a crash, verify it has exited before removing only this lock directory.`,
        { cause },
      );
    }
    try {
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
        { mode: 0o600 },
      );
      return operation();
    } finally {
      unlinkSync(join(lock, "owner.json"));
      rmdirSync(lock);
    }
  }

  assertOutside(path: string): void {
    if (containsPath(path, resolve(this.directory))) {
      throw new PluginError(
        "unsafe_cleanup",
        "Plugin state is inside the target checkout. Move the state directory outside it before cleanup.",
      );
    }
  }
}
