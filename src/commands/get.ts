import { Command } from "commander";
import chalk from "chalk";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput } from "../lib/output.js";

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

      out.succeed(post.title);
      out.info(`${chalk.dim("URL:")}          opendocs.cc${post.url}`);
      out.info(`${chalk.dim("Post ID:")}      ${post.id}`);
      out.info(`${chalk.dim("Slug:")}         ${post.slug}`);
      out.info(`${chalk.dim("Visibility:")}   ${post.visibility}`);
      out.info(`${chalk.dim("Published:")}    ${post.isPublished ? "yes" : "no"}`);
      out.info(`${chalk.dim("Version:")}      ${post.versionNumber}`);
      out.info(
        `${chalk.dim("Updated:")}      ${new Date(post.updatedAt).toLocaleDateString()}`,
      );
      if (post.tags && post.tags.length > 0) {
        out.info(`${chalk.dim("Tags:")}         ${post.tags.join(", ")}`);
      }
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
