import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const unpublishCommand = new Command("unpublish")
  .description("Unpublish a post")
  .argument("<idOrSlug>", "Post ID (UUID) or slug — see `opendocs list`")
  .action(async (postId, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin(`Unpublishing ${brand.muted(postId)}...`);

      const client = createApiClient(config);
      const result = await client.unpublish(postId, {
        workspaceId: config.workspaceId,
        projectId: config.projectId,
      });

      out.succeed(`Post ${brand.muted(postId)} unpublished`);
      out.result(result);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
