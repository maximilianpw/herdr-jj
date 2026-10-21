import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Commands, parseJson } from "../src/command";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const realJj = Bun.which("jj");
if (!realJj) throw new Error("Tests require jj 0.46+");

export function fixture(layout: "standard" | "submodule" = "standard") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "herdr-jj-test-")));
  const repo = join(directory, "project with spaces");
  const state = join(directory, "state");
  const bin = join(directory, "bin");
  const control = join(directory, "control.json");
  const log = join(directory, "herdr.jsonl");
  const jjConfig = join(directory, "jj.toml");
  mkdirSync(bin);
  writeFileSync(
    jjConfig,
    '[user]\nname = "Plugin Test"\nemail = "plugin@example.invalid"\n[revset-aliases]\n"trunk()" = "main"\n[signing]\nbehavior = "drop"\n[snapshot]\nmax-new-file-size = "1MiB"\n',
  );
  writeFileSync(control, "{}");
  const herdr = join(bin, "herdr");
  writeFileSync(
    herdr,
    `#!${process.execPath}\nimport { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(process.env.TEST_CONTROL, 'utf8'));
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (control.failHerdr || (control.failOpen && args[0] === 'worktree')) process.exit(1);
if (args[1] === 'report-metadata') process.exit(0);
let result = { type: 'ok' };
if (args[0] === 'pane') result = { panes: control.panes ?? [] };
if (args[0] === 'workspace' && args[1] === 'list') result = { workspaces: control.workspaces ?? [] };
if (control.malformed) console.log('{}');
else console.log(JSON.stringify({ result }));
`,
  );
  chmodSync(herdr, 0o755);
  writeFileSync(
    join(bin, "jj"),
    `#!${process.execPath}\nimport { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(process.env.TEST_CONTROL, 'utf8'));
if ((control.failAdd && args.includes('add')) || (control.failForget && args.includes('forget'))) process.exit(1);
const child = Bun.spawnSync([${JSON.stringify(realJj)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(child.exitCode);
`,
  );
  chmodSync(join(bin, "jj"), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: directory,
    JJ_CONFIG: jjConfig,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HERDR_BIN_PATH: herdr,
    TEST_CONTROL: control,
    TEST_LOG: log,
    TERM: "xterm-256color",
  };
  const commands = new Commands(env);
  if (layout === "submodule") {
    const source = join(directory, "source");
    commands.output("git", ["init", source], directory);
    commands.git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "seed submodule",
    ]);
    commands.output("git", ["init", directory], directory);
    commands.git(directory, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      repo,
    ]);
  }
  commands.output("jj", ["git", "init", "--colocate", repo], directory);
  writeFileSync(join(repo, "hello.txt"), "trunk\n");
  commands.jj(repo, ["describe", "-m", "seed"], true);
  commands.jj(repo, ["bookmark", "set", "main", "-r", "@"]);
  commands.jj(repo, [
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    "main",
  ]);
  commands.jj(repo, ["new"], true);
  return {
    directory,
    repo,
    state,
    bin,
    env,
    commands,
    cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}, target = repo) {
      const result = spawnSync(
        process.execPath,
        [cli, ...args, "--repo", target, "--state-dir", state],
        {
          cwd: directory,
          env: { ...env, ...extraEnv },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      return {
        ...result,
        json: () =>
          parseJson(result.status === 0 ? result.stdout : result.stderr),
      };
    },
    control(value: unknown) {
      writeFileSync(control, JSON.stringify(value));
    },
    calls(): unknown[] {
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(parseJson);
      } catch {
        return [];
      }
    },
    path(name: string) {
      return `${repo}.jj-${name}`;
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;
