import { Command } from "commander";
import fs from "node:fs";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const pullCommand = new Command("pull")
  .description("Download the raw markdown of a post")
  .argument("<idOrSlug>", "Post ID (UUID) or slug — see `opendocs list`")
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
      out.spin(`Downloading document ${brand.muted(postId)}...`);

      const client = createApiClient(config);
      const data = await client.pullPost(postId, {
        workspaceId: config.workspaceId,
      });

      if (opts.stdout) {
        out.succeed(`Downloaded ${brand.value(data.title)} ${brand.muted(`(v${data.versionNumber})`)}`);
        if (!globalOpts.json) {
          process.stdout.write(data.markdown);
        }
        out.result(data);
        return;
      }

      const filename = opts.output || `${data.slug}.md`;
      fs.writeFileSync(filename, data.markdown);

      out.succeed(`Downloaded ${brand.value(data.title)} ${brand.muted(`(v${data.versionNumber})`)}`);
      out.info(`${brand.label("Saved to:")} ${brand.purple(filename)}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
