import ora, { type Ora } from "ora";
import chalk from "chalk";

export interface Output {
  spin(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  info(text: string): void;
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
      spinner = ora(text).start();
    },
    succeed(text) {
      if (spinner) {
        spinner.succeed(text);
        spinner = null;
      } else {
        console.log(chalk.green("✔") + " " + text);
      }
    },
    fail(text) {
      if (spinner) {
        spinner.fail(text);
        spinner = null;
      } else {
        console.log(chalk.red("✖") + " " + text);
      }
    },
    info(text) {
      console.log("  " + text);
    },
    result() {},
    error(err) {
      if (spinner) {
        spinner.fail();
        spinner = null;
      }
      console.error(chalk.red("Error:") + " " + err.message);
      process.exit(1);
    },
  };
}
