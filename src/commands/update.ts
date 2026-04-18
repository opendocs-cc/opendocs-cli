import { Command } from "commander";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { readMarkdownFile } from "../lib/markdown.js";

export const updateCommand = new Command("update")
  .description("Update an existing published post")
  .argument("<file>", "Path to .md file")
  .requiredOption(
    "--post-id <idOrSlug>",
    "Post ID (UUID) or slug of the post to update — see `opendocs list`",
  )
  .option("--title <title>", "Override document title")
  .option(
    "--visibility <visibility>",
    "private | workspace | public",
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

      out.spin(`Updating ${brand.value(path.basename(file))}...`);

      const client = createApiClient(config);
      const result = await client.update(
        opts.postId,
        {
          markdown: content,
          title: opts.title || undefined,
          visibility: opts.visibility || undefined,
          workspaceId: config.workspaceId,
          tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
          sourcePath: path.basename(file),
          confirmPublic: opts.confirmPublic || undefined,
        },
        { workspaceId: config.workspaceId },
      );

      out.succeed(
        `Updated ${brand.value(result.title)} to ${brand.purpleBold(`v${result.versionNumber}`)}`,
      );
      out.result(result);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
