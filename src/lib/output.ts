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
  succeed(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  result(data: unknown): void;
  error(err: { status?: number; code?: string; message: string }): void;
}

export function createOutput(json: boolean): Output {
  let spinner: Ora | null = null;

  if (json) {
    return {
      spin() {},
      succeed() {},
      fail() {},
      info() {},
      warn() {},
      result(data) {
        console.log(JSON.stringify(data));
      },
      error(err) {
        console.error(
          JSON.stringify({
            error: err.code ?? "error",
            message: err.message,
          }),
        );
        process.exit(1);
      },
    };
  }

  return {
    spin(text) {
      spinner = ora({
        text,
        color: "magenta",
        spinner: "dots",
      }).start();
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
      process.exit(1);
    },
  };
}
