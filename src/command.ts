import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

export type FailureCode =
  | "invalid_input"
  | "invalid_response"
  | "command_failed"
  | "not_jj"
  | "not_colocated"
  | "state_conflict"
  | "busy"
  | "unsafe_cleanup"
  | "partial_operation"
  | "cancelled";

export class PluginError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function errorEnvelope(cause: unknown) {
  const error =
    cause instanceof PluginError
      ? cause
      : new PluginError(
          "command_failed",
          "Plugin operation failed unexpectedly. Inspect the repository and plugin state before retrying.",
          { cause },
        );
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: {},
      requestId: randomUUID(),
      retryable: error.code === "busy" || error.code === "partial_operation",
    },
  };
}

export function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  source: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new PluginError(
      "invalid_response",
      `Invalid ${source}. Check tool versions or reconcile the saved state before retrying.`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new PluginError(
      "invalid_response",
      "Invalid JSON response. Check the tool version or saved state before retrying.",
      { cause },
    );
  }
}

export class Commands {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  run(executable: string, args: string[], cwd: string) {
    const env: NodeJS.ProcessEnv = { ...this.env, GIT_OPTIONAL_LOCKS: "0" };
    // Inherited Git targeting variables must not override the validated cwd.
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("GIT_") &&
        key !== "GIT_OPTIONAL_LOCKS" &&
        key !== "GIT_CONFIG_GLOBAL" &&
        key !== "GIT_CONFIG_NOSYSTEM"
      ) {
        delete env[key];
      }
    }
    const result = spawnSync(executable, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result;
  }

  output(executable: string, args: string[], cwd: string): string {
    const result = this.run(executable, args, cwd);
    if (result.status !== 0 || result.error) {
      throw new PluginError(
        "command_failed",
        `Command failed: ${executable} ${args[0] ?? ""} (exit ${result.status ?? "unavailable"}). Check the tool and repository with that command before retrying; a mutation may have partially completed.`,
        { cause: result.error ?? new Error(result.stderr) },
      );
    }
    return result.stdout;
  }

  jj(cwd: string, args: string[], snapshot = false): string {
    return this.output(
      "jj",
      [
        "--color=never",
        "--no-pager",
        ...(snapshot ? [] : ["--ignore-working-copy"]),
        ...args,
      ],
      cwd,
    );
  }

  git(cwd: string, args: string[]): string {
    return this.output("git", ["-C", cwd, ...args], cwd);
  }
}
