import { Command } from "commander";
import readline from "node:readline";
import { saveConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

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

      out.spin("Validating API key with OpenDocs...");

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
        workspaceSlug: data.onboarding.workspace.slug,
      });

      out.succeed(
        `Logged in as ${brand.purpleBold(data.onboarding.username)} ${brand.muted("·")} workspace: ${brand.value(data.onboarding.workspace.name)}`,
      );

      // Multi-workspace hint — best-effort. If the user belongs to more
      // than one workspace, let them know how to see the full list and
      // switch. Failures here are non-fatal; login already succeeded.
      try {
        const { workspaces } = await client.listWorkspaces();
        if (workspaces.length > 1) {
          out.info(
            brand.muted(
              `You belong to ${workspaces.length} workspaces. Run ${brand.purple("opendocs workspace list")} to see them all.`,
            ),
          );
        }
      } catch {
        // Swallow — this is a hint, not a requirement.
      }

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
  if (!process.stdin.isTTY) {
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

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";
    let done = false;

    process.stdout.write("Enter your API key: ");
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (answer: string) => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      resolve(answer.trim());
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          stdin.setRawMode(wasRaw);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          finish(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    const onEnd = () => {
      finish(value);
    };

    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}
