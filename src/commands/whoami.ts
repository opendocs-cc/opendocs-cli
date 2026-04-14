import { Command } from "commander";
import chalk from "chalk";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput } from "../lib/output.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current authentication status")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Checking authentication...");
      const client = createApiClient(config);
      const data = await client.me();

      const username = data.onboarding?.username ?? "unknown";
      const workspace = data.onboarding?.workspace?.name ?? "none";

      out.succeed("Authenticated");
      out.info(`${chalk.dim("Username:")}   ${username}`);
      out.info(`${chalk.dim("Workspace:")}  ${workspace}`);
      out.info(`${chalk.dim("API URL:")}    ${config.apiUrl}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
