import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Spawns the CLI as a real subprocess — `node --import <tsx-loader> src/index.ts <args>` — so each
 * test exercises the same commander bootstrapping path the user sees. Running
 * the commands in-process would break the moment a command calls
 * `process.exit(…)` (and several of ours do, via out.error()).
 *
 * Config is sandboxed via XDG_CONFIG_HOME pointing at a per-call tmpdir, so
 * tests can freely `login` / `logout` / seed a pre-authenticated config
 * without ever touching the real ~/.config/opendocs/config.json.
 *
 * The API URL override can be passed either as the flag `--api-url` (global
 * option) or via the `OPENDOCS_API_URL` env var — the helper does the latter
 * so the flag stays observable in tests that need to assert it's NOT being
 * used (e.g. login's default URL path).
 */

const __filename = fileURLToPath(import.meta.url);
const CLI_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const CLI_ENTRY = path.join(CLI_ROOT, "src", "index.ts");
const TSX_LOADER = path.join(CLI_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

export type RunOptions = {
  /** Extra env vars. Merged on top of a minimal base (PATH, HOME, etc). */
  env?: Record<string, string>;
  /** Working directory for the subprocess (defaults to a fresh tmpdir). */
  cwd?: string;
  /** Override API URL via env var. Most tests will pass the mock's .url here. */
  apiUrl?: string;
  /** Pre-seeded config file written into XDG_CONFIG_HOME before spawn. */
  config?: {
    apiKey?: string;
    apiUrl?: string;
    userId?: string;
    username?: string;
    workspaceId?: string;
    workspaceName?: string;
  };
  /** Text piped to the child's stdin (for `login` interactive prompt tests). */
  stdin?: string;
  /** Hard cap on wall-clock time before we kill the child. */
  timeoutMs?: number;
};

export type RunResult = {
  /** Captured stdout as a utf-8 string. */
  stdout: string;
  /** Captured stderr as a utf-8 string. */
  stderr: string;
  /** Captured stdout as a Buffer — for --stdout binary tests (pull/export). */
  stdoutBuffer: Buffer;
  /** Exit code; null if the process was killed by a signal. */
  exitCode: number | null;
  /** Signal name if the process was killed. */
  signal: NodeJS.Signals | null;
  /** Working directory used for this run — useful for asserting file writes. */
  cwd: string;
  /** Helper: parse stdout as JSON. Throws a clear error on malformed output. */
  json<T = unknown>(): T;
};

export type RunCli = (args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * Per-test harness. Call `makeRunCli()` inside `beforeEach` and tear it down
 * in `afterEach` via the returned `cleanup`. Each run within the same harness
 * shares the same XDG_CONFIG_HOME, so a `login` call persists a config that a
 * subsequent `whoami` can read — mirroring how a real user would use the CLI.
 */
export function makeRunCli(): {
  run: RunCli;
  configDir: string;
  cleanup: () => void;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-cli-test-"));

  const run: RunCli = async (args, options = {}) => {
    const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-cli-cwd-"));

    // Seed a pre-authenticated config if requested — writes directly to the
    // same path the config.ts getConfigDir() resolves to under our
    // XDG_CONFIG_HOME override.
    //
    // Only apiKey and apiUrl get defaults; callers that need workspaceId /
    // username must pass them explicitly. This keeps the "missing workspace"
    // failure mode reachable — otherwise an implicit default would mask it.
    if (options.config) {
      const dir = path.join(configDir, "opendocs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify(
          {
            apiKey: options.config.apiKey ?? "od_live_test_seed",
            apiUrl:
              options.config.apiUrl ?? options.apiUrl ?? "http://127.0.0.1:1",
            ...(options.config.userId !== undefined && { userId: options.config.userId }),
            ...(options.config.username !== undefined && { username: options.config.username }),
            ...(options.config.workspaceId !== undefined && { workspaceId: options.config.workspaceId }),
            ...(options.config.workspaceName !== undefined && { workspaceName: options.config.workspaceName }),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }

    const env: NodeJS.ProcessEnv = {
      // Keep PATH so node resolves consistently in spawned subprocesses.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Our sandbox — config.ts reads this to locate config.json.
      XDG_CONFIG_HOME: configDir,
      // Disable chalk colors in output so assertions don't need to strip ANSI.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      // Disable ora spinner (interactive TTY check) — it writes to stderr
      // anyway, but we don't want spinner frames polluting output.
      CI: "1",
      ...(options.apiUrl ? { OPENDOCS_API_URL: options.apiUrl } : {}),
      ...options.env,
    };

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn("node", ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 25_000);

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const stdoutBuffer = Buffer.concat(stdoutChunks);
        const stderrBuffer = Buffer.concat(stderrChunks);
        const stdout = stdoutBuffer.toString("utf8");
        const stderr = stderrBuffer.toString("utf8");

        if (timedOut) {
          reject(
            new Error(
              `CLI timed out after ${options.timeoutMs ?? 25_000}ms.\nargs: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }

        resolve({
          stdout,
          stderr,
          stdoutBuffer,
          exitCode: code,
          signal,
          cwd,
          json<T>(): T {
            try {
              return JSON.parse(stdout) as T;
            } catch (err) {
              throw new Error(
                `Expected stdout to be JSON but got:\n${stdout}\nstderr:\n${stderr}\nparse error: ${(err as Error).message}`,
              );
            }
          },
        });
      });
    });
  };

  return {
    run,
    configDir,
    cleanup() {
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

/** Read the seeded/persisted CLI config (post-run) for assertion purposes. */
export function readCliConfig(configDir: string): unknown | null {
  const p = path.join(configDir, "opendocs", "config.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Absolute path to the (expected) config file inside a test's sandbox. */
export function cliConfigPath(configDir: string): string {
  return path.join(configDir, "opendocs", "config.json");
}
