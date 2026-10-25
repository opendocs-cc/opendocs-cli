import { Command } from "commander";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { readMarkdownFile } from "../lib/markdown.js";
import { uploadLocalImagesAndRewrite } from "../lib/images.js";

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
    "private | workspace | public (omit to keep current visibility)",
  )
  .option("--tags <tags>", "Replace tags with this comma-separated list (omit to keep current tags)")
  .option("--confirm-public", "Confirm public publishing")
  .action(async (file, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);

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

      const client = createApiClient(config);
      out.spin(`Updating ${brand.value(path.basename(file))}...`);

      let toUpdate = content;
      try {
        const { markdown: rewritten, report } =
          await uploadLocalImagesAndRewrite({
            markdown: content,
            sourceFile: file,
            client,
            workspaceId: config.workspaceId,
          });
        toUpdate = rewritten;
        for (const s of report.skipped) {
          out.warn(`Image skipped: ${s.original} — ${s.reason}`);
        }
      } catch (err: unknown) {
        const e = err as { message?: string; status?: number };
        if (e.status === 503) {
          out.stopSpinner();
          out.warn(
            "Image storage is not configured on the server; updating without uploading local images.",
          );
          out.spin(`Updating ${brand.value(path.basename(file))}...`);
        } else {
          out.stopSpinner();
          out.error({
            code: "image_upload_failed",
            message: e.message ?? "Failed to upload inline images.",
          });
          return;
        }
      }

      const result = await client.update(
        opts.postId,
        {
          markdown: toUpdate,
          title: opts.title || undefined,
          visibility: opts.visibility || undefined,
          workspaceId: config.workspaceId,
          tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
          sourcePath: path.basename(file),
          confirmPublic: opts.confirmPublic || undefined,
        },
        { workspaceId: config.workspaceId, projectId: config.projectId },
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
