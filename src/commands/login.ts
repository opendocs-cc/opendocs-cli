import { Command } from "commander";
import readline from "node:readline";
import { saveConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput } from "../lib/output.js";

export const loginCommand = new Command("login")
  .description("Authenticate with your OpenDocs API key")
  .option("--key <key>", "API key (or set OPENDOCS_API_KEY env var)")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const apiUrl =
      globalOpts.apiUrl ||
      process.env.OPENDOCS_API_URL ||
      "https://api.opendocs.cc";

    try {
      // Resolve API key: flag > env > interactive prompt
      let apiKey: string = opts.key || process.env.OPENDOCS_API_KEY || "";

      if (!apiKey) {
        apiKey = await promptForKey();
      }

      if (!apiKey) {
        out.error({ message: "No API key provided." });
        return;
      }

      if (!apiKey.startsWith("od_live_")) {
        out.error({
          code: "invalid_key_format",
          message: 'Invalid API key format. Keys start with "od_live_".',
        });
        return;
      }

      out.spin("Validating key...");

      const client = createApiClient({ apiKey, apiUrl });
      const data = await client.me();

      if (!data.onboarding?.username || !data.onboarding?.workspace) {
        out.fail("Onboarding incomplete");
        out.error({
          code: "onboarding_incomplete",
          message:
            "Complete onboarding on the OpenDocs web app before using the CLI.",
        });
        return;
      }

      saveConfig({
        apiKey,
        apiUrl,
        userId: data.userId,
        username: data.onboarding.username,
        workspaceId: data.onboarding.workspace.id,
        workspaceName: data.onboarding.workspace.name,
      });

      out.succeed(
        `Logged in as ${data.onboarding.username} (workspace: ${data.onboarding.workspace.name})`,
      );
      out.result({
        success: true,
        username: data.onboarding.username,
        workspaceId: data.onboarding.workspace.id,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

function promptForKey(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("Enter your API key: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
