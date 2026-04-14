import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

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
      out.spin("Verifying credentials with OpenDocs...");
      const client = createApiClient(config);
      const data = await client.me();

      const username = data.onboarding?.username ?? "unknown";
      const workspace = data.onboarding?.workspace?.name ?? "none";

      out.succeed("Authenticated");
      out.info(`${brand.label("Username:")}   ${brand.purpleBold(username)}`);
      out.info(`${brand.label("Workspace:")}  ${brand.value(workspace)}`);
      out.info(`${brand.label("API URL:")}    ${brand.muted(config.apiUrl)}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
