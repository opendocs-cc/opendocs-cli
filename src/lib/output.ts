import ora, { type Ora } from "ora";
import chalk from "chalk";

// Brand palette
export const brand = {
  purple: chalk.hex("#7F56D9"),
  purpleBold: chalk.hex("#7F56D9").bold,
  url: chalk.hex("#7F56D9").underline,
  label: chalk.hex("#737373"),
  value: chalk.white.bold,
  success: chalk.hex("#1aa34d"),
  error: chalk.hex("#ef4444"),
  warn: chalk.hex("#eab308"),
  muted: chalk.dim,
};

export interface Output {
  spin(text: string): void;
  stopSpinner(): void;
  succeed(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  result(data: unknown): void;
  error(err: OutputError): void;
}

export interface OutputError {
  status?: number;
  code?: string;
  message: string;
  /** Extra machine-readable fields merged into the `--json` error object (e.g. `approveUrl`). */
  extra?: Record<string, unknown>;
  /** What to do next, printed under the message in human mode only. */
  hint?: string;
}

// The command's output, so the API client can report rate-limit waits
// without every command passing its Output down (see showRateLimitWait).
let active: { json: boolean; spinner: () => Ora | null } | null = null;

/**
 * Called by the API client while it waits out a rate limit (lib/api.ts), so
 * a pause doesn't look like a hang: noted on the running spinner, or printed
 * as a line when there isn't one. Silent in --json mode. Returns a function
 * that puts the spinner text back.
 */
export function showRateLimitWait(seconds: number): () => void {
  if (!active || active.json) return () => {};
  const note = `rate limited, retrying in ${seconds}s`;
  const spinner = active.spinner();
  if (spinner) {
    const text = spinner.text;
    spinner.text = `${text} ${brand.muted(`(${note})`)}`;
    return () => {
      spinner.text = text;
    };
  }
  console.log("  " + brand.muted(`Rate limited, retrying in ${seconds}s...`));
  return () => {};
}

export function createOutput(json: boolean): Output {
  let spinner: Ora | null = null;
  active = { json, spinner: () => spinner };

  if (json) {
    return {
      spin() {},
      stopSpinner() {},
      succeed() {},
      fail() {},
      info() {},
      warn() {},
      result(data) {
        console.log(JSON.stringify(data));
      },
      error(err) {
        const { error: _e, message: _m, ...extra } = err.extra ?? {};
        console.error(
          JSON.stringify({
            error: err.code ?? "error",
            message: err.message,
            ...extra,
          }),
        );
        process.exit(1);
      },
    };
  }

  return {
    spin(text) {
      // Stop any in-flight spinner before starting a new one. Without this,
      // a second `spin()` call orphans the previous ora instance — it keeps
      // rendering, pins the Node event loop open, and triggers ora's
      // "Multiple concurrent spinners detected" warning.
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      spinner = ora({
        text,
        color: "magenta",
        spinner: "dots",
      }).start();
    },
    stopSpinner() {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
    },
    succeed(text) {
      if (spinner) {
        spinner.succeed(text);
        spinner = null;
      } else {
        console.log(brand.success("✔") + " " + text);
      }
    },
    fail(text) {
      if (spinner) {
        spinner.fail(text);
        spinner = null;
      } else {
        console.log(brand.error("✖") + " " + text);
      }
    },
    info(text) {
      console.log("  " + text);
    },
    warn(text) {
      console.log("  " + brand.warn("⚠") + " " + text);
    },
    result() {},
    error(err) {
      if (spinner) {
        spinner.fail();
        spinner = null;
      }
      console.error(brand.error("Error:") + " " + err.message);
      if (err.hint) console.error(err.hint);
      process.exit(1);
    },
  };
}
