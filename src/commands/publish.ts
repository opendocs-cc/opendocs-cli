import { Command } from "commander";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { readMarkdownFile } from "../lib/markdown.js";

export const publishCommand = new Command("publish")
  .description("Publish a Markdown file to OpenDocs")
  .argument("<file>", "Path to .md file")
  .option("--title <title>", "Override document title")
  .option("--slug <slug>", "Custom URL slug")
  .option(
    "--visibility <visibility>",
    "private | workspace | public",
    "workspace",
  )
  .option("--tags <tags>", "Comma-separated tags")
  .option("--confirm-public", "Confirm public publishing")
  .action(async (file, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      const { content } = readMarkdownFile(file);

      if (!config.workspaceId) {
        out.error({
          code: "no_workspace",
          message:
            'No workspace found. Run "opendocs login" to refresh your config.',
        });
        return;
      }

      out.spin("Uploading content...");

      const client = createApiClient(config);
      const result = await client.publish({
        markdown: content,
        title: opts.title || undefined,
        slug: opts.slug || undefined,
        visibility: opts.visibility,
        workspaceId: config.workspaceId,
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
        sourcePath: path.basename(file),
        confirmPublic: opts.confirmPublic || undefined,
      });

      out.succeed("Uploading content...");
      out.succeed(`URL generated: opendocs.cc/${config.username}/${result.slug}`);
      out.result(result);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
