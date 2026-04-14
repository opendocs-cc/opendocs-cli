import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const listCommand = new Command("list")
  .description("List your articles")
  .option("--page <page>", "Page number", "1")
  .option("--limit <limit>", "Articles per page (max 100)", "20")
  .option("--tag <tag>", "Filter by tag")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Fetching your documents...");

      const client = createApiClient(config);
      const page = parseInt(opts.page) || 1;
      const limit = parseInt(opts.limit) || 20;
      const data = await client.listPosts({ page, limit, tag: opts.tag });

      const { pagination } = data;
      out.succeed(
        `Showing ${brand.purpleBold(String(data.posts.length))} of ${pagination.total} article(s) ${brand.muted(`(page ${pagination.page}/${pagination.totalPages})`)}`,
      );

      if (data.posts.length === 0) {
        out.info(`No articles yet. Publish one with: ${brand.purple("opendocs publish <file>")}`);
      } else {
        const header = `  ${pad("Title", 30)} ${pad("Slug", 24)} ${pad("Visibility", 12)} ${pad("Updated", 14)} ${pad("Tags", 20)}`;
        out.info(brand.label(header));
        out.info(brand.label("  " + "\u2500".repeat(102)));

        for (const post of data.posts) {
          const updated = formatRelativeDate(post.updatedAt);
          const tags = post.tags?.length ? post.tags.map((t: string) => brand.purple(t)).join(brand.muted(", ")) : brand.muted("—");
          const vis = post.visibility === "public" ? brand.success(pad(post.visibility, 12)) : pad(post.visibility, 12);
          out.info(
            `  ${brand.value(pad(post.title || "(untitled)", 30))} ${brand.muted(pad(post.slug, 24))} ${vis} ${brand.muted(pad(updated, 14))} ${tags}`,
          );
        }

        if (pagination.page < pagination.totalPages) {
          out.info("");
          out.info(
            brand.muted(`  Page ${pagination.page} of ${pagination.totalPages}. Use ${brand.purple(`--page ${pagination.page + 1}`)} to see more.`),
          );
        }
      }

      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

function pad(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…";
  return str.padEnd(len);
}

function formatRelativeDate(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
