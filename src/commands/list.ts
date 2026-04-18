import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List your articles in the active workspace")
  .option("--page <page>", "Page number", "1")
  .option("--limit <limit>", "Articles per page (max 100)", "20")
  .option("--tag <tag>", "Filter by tag")
  .option(
    "--all",
    "Show articles across every workspace you belong to (default: active workspace only)",
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      const workspaceLabel = config.workspaceName ?? "the active workspace";
      out.spin(
        opts.all
          ? "Fetching documents across all your workspaces..."
          : `Fetching documents in ${workspaceLabel}...`,
      );

      const client = createApiClient(config);
      const page = parseInt(opts.page) || 1;
      const limit = parseInt(opts.limit) || 20;
      // Default: scope to the CLI's active workspace. `--all` opts out by
      // omitting the workspaceId — server then returns every workspace
      // the user has authored in.
      const workspaceId = opts.all ? undefined : config.workspaceId;
      const data = await client.listPosts({
        page,
        limit,
        tag: opts.tag,
        workspaceId,
      });

      const { pagination } = data;
      const scopeLabel = opts.all
        ? "all workspaces"
        : `workspace: ${config.workspaceName ?? config.workspaceSlug ?? "?"}`;
      out.succeed(
        `Showing ${brand.purpleBold(String(data.posts.length))} of ${pagination.total} article(s) ${brand.muted(`(page ${pagination.page}/${Math.max(pagination.totalPages, 1)}, ${scopeLabel})`)}`,
      );

      if (data.posts.length === 0) {
        if (opts.all) {
          out.info(
            `No articles yet. Publish one with: ${brand.purple("opendocs publish <file>")}`,
          );
        } else {
          // Keep "No articles yet" as the headline for consistency with the
          // --all path — tests and users both scan for it. The workspace
          // context and the --all hint follow.
          out.info(
            `No articles yet in ${brand.value(workspaceLabel)}. Publish one with ${brand.purple("opendocs publish <file>")}, or run ${brand.purple("opendocs list --all")} to include other workspaces.`,
          );
        }
      } else {
        // `--all` adds a Workspace column by shrinking the other columns
        // slightly; scoped mode keeps the original 5-column layout.
        if (opts.all) {
          const header = `  ${pad("Title", 26)} ${pad("Workspace", 14)} ${pad("Slug", 22)} ${pad("Visibility", 10)} ${pad("Updated", 12)} ${pad("Tags", 18)}`;
          out.info(brand.label(header));
          out.info(brand.label("  " + "\u2500".repeat(106)));
          for (const post of data.posts) {
            const updated = formatRelativeDate(post.updatedAt);
            const tags = post.tags?.length
              ? post.tags.map((t: string) => brand.purple(t)).join(brand.muted(", "))
              : brand.muted("—");
            const vis =
              post.visibility === "public"
                ? brand.success(pad(post.visibility, 10))
                : pad(post.visibility, 10);
            const isActiveWs =
              !!config.workspaceSlug &&
              post.workspaceSlug === config.workspaceSlug;
            const wsCell = isActiveWs
              ? brand.purpleBold(pad(post.workspaceSlug, 14))
              : brand.muted(pad(post.workspaceSlug, 14));
            out.info(
              `  ${brand.value(pad(post.title || "(untitled)", 26))} ${wsCell} ${brand.muted(pad(post.slug, 22))} ${vis} ${brand.muted(pad(updated, 12))} ${tags}`,
            );
          }
        } else {
          const header = `  ${pad("Title", 30)} ${pad("Slug", 24)} ${pad("Visibility", 12)} ${pad("Updated", 14)} ${pad("Tags", 20)}`;
          out.info(brand.label(header));
          out.info(brand.label("  " + "\u2500".repeat(102)));
          for (const post of data.posts) {
            const updated = formatRelativeDate(post.updatedAt);
            const tags = post.tags?.length
              ? post.tags.map((t: string) => brand.purple(t)).join(brand.muted(", "))
              : brand.muted("—");
            const vis =
              post.visibility === "public"
                ? brand.success(pad(post.visibility, 12))
                : pad(post.visibility, 12);
            out.info(
              `  ${brand.value(pad(post.title || "(untitled)", 30))} ${brand.muted(pad(post.slug, 24))} ${vis} ${brand.muted(pad(updated, 14))} ${tags}`,
            );
          }
        }

        if (pagination.page < pagination.totalPages) {
          out.info("");
          out.info(
            brand.muted(
              `  Page ${pagination.page} of ${pagination.totalPages}. Use ${brand.purple(`--page ${pagination.page + 1}`)} to see more.`,
            ),
          );
        }
      }

      // Surface the scope in JSON too so scripts can tell whether results
      // are workspace-scoped (default) or spanning every workspace.
      out.result({
        ...data,
        scope: opts.all ? "all" : "workspace",
        workspaceSlug: opts.all ? null : config.workspaceSlug ?? null,
      });
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
