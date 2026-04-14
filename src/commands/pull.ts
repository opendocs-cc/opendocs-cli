import { Command } from "commander";
import fs from "node:fs";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput } from "../lib/output.js";

export const pullCommand = new Command("pull")
  .description("Download the raw markdown of a post")
  .argument("<postId>", "ID of the post")
  .option("-o, --output <path>", "Output file path")
  .option("--stdout", "Print markdown to stdout instead of saving")
  .action(async (postId, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Downloading...");

      const client = createApiClient(config);
      const data = await client.pullPost(postId);

      if (opts.stdout) {
        // In stdout mode, stop spinner and print raw markdown
        out.succeed(`Downloaded "${data.title}" (v${data.versionNumber})`);
        if (!globalOpts.json) {
          process.stdout.write(data.markdown);
        }
        out.result(data);
        return;
      }

      const filename = opts.output || `${data.slug}.md`;
      fs.writeFileSync(filename, data.markdown);

      out.succeed(`Downloaded "${data.title}" (v${data.versionNumber})`);
      out.info(`Saved to: ${filename}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
