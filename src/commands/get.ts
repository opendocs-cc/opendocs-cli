import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const getCommand = new Command("get")
  .description("Get details of a post")
  .argument("<postId>", "ID of the post")
  .action(async (postId, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Fetching post...");

      const client = createApiClient(config);
      const data = await client.getPost(postId);
      const { post } = data;

      out.succeed(brand.value(post.title));
      out.info(`${brand.label("URL:")}          ${brand.url(`opendocs.cc${post.url}`)}`);
      out.info(`${brand.label("Post ID:")}      ${brand.muted(post.id)}`);
      out.info(`${brand.label("Slug:")}         ${post.slug}`);
      out.info(`${brand.label("Visibility:")}   ${post.visibility === "public" ? brand.success(post.visibility) : post.visibility}`);
      out.info(`${brand.label("Published:")}    ${post.isPublished ? brand.success("yes") : brand.warn("no")}`);
      out.info(`${brand.label("Version:")}      v${post.versionNumber}`);
      out.info(
        `${brand.label("Updated:")}      ${new Date(post.updatedAt).toLocaleDateString()}`,
      );
      if (post.tags && post.tags.length > 0) {
        out.info(`${brand.label("Tags:")}         ${post.tags.map((t: string) => brand.purple(t)).join(brand.muted(", "))}`);
      }
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
