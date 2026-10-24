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
  .option("--all-projects", "Show every project in the active workspace")
  .option("--project <slugOrId>", "Show one project (instead of the active one)")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      const workspaceLabel = config.workspaceName ?? "the active workspace";
      let projectLabel = opts.project ? String(opts.project) : (config.projectName ?? "Default");
      out.spin(
        opts.all
          ? "Fetching documents across all your workspaces..."
          : opts.allProjects
            ? `Fetching documents in ${workspaceLabel} across all projects...`
            : `Fetching documents in ${workspaceLabel} / ${projectLabel}...`,
      );

      const client = createApiClient(config);
      const page = parsePositiveInt(opts.page, "page", 1);
      if (typeof page !== "number") {
        out.error(page);
        return;
      }
      const limit = parsePositiveInt(opts.limit, "limit", 20, 100);
      if (typeof limit !== "number") {
        out.error(limit);
        return;
      }
      // Default: scope to the CLI's active workspace. `--all` opts out by
      // omitting the workspaceId — server then returns every workspace
      // the user has authored in.
      const workspaceId = opts.all ? undefined : config.workspaceId;
      let projectId = opts.all || opts.allProjects ? undefined : config.projectId;
      if (opts.project && workspaceId) {
        const { projects } = await client.listProjects(workspaceId);
        const match = projects.find(
          (p) => p.id === opts.project || p.slug === opts.project || p.name.toLowerCase() === String(opts.project).toLowerCase(),
        );
        if (!match) {
          out.error({
            code: "project_not_found",
            message: `Project "${opts.project}" was not found. Run \`opendocs project list\`.`,
          });
          return;
        }
        projectId = match.id;
        projectLabel = match.name;
      }
      if (!projectId && workspaceId && !opts.allProjects) {
        const { project } = await client.defaultProject(workspaceId);
        projectId = project.id;
      }
      const data = await client.listPosts({
        page,
        limit,
        tag: opts.tag,
        workspaceId,
        projectId,
      });

      const { pagination } = data;
      const scopeLabel = opts.all
        ? "all workspaces"
        : opts.allProjects
          ? `workspace: ${config.workspaceName ?? config.workspaceSlug ?? "?"}, all projects`
          : `workspace: ${config.workspaceName ?? config.workspaceSlug ?? "?"}, project: ${projectLabel}`;
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
        // Compute the slug column width from the longest slug in this
        // result set (with a sensible floor so short-slug workspaces
        // don't produce a cramped column). The slug is what the user
        // copies to run `opendocs export`, `get`, `delete`, etc., so
        // we never want to truncate it — truncating the title is fine
        // because it's only for human scanning. Divider length tracks
        // the dynamic slug width so the underline still stretches
        // across the full table.
        const slugFloor = opts.all ? 22 : 24;
        const slugWidth = Math.max(
          slugFloor,
          ...data.posts.map((p: { slug: string }) => p.slug.length),
        );

        // `--all` adds a Workspace column by shrinking the other columns
        // slightly; scoped mode keeps the original 5-column layout.
        if (opts.all) {
          const dividerLen = 26 + 1 + 14 + 1 + slugWidth + 1 + 10 + 1 + 12 + 1 + 18;
          const header = `  ${pad("Title", 26)} ${pad("Workspace", 14)} ${pad("Slug", slugWidth)} ${pad("Visibility", 10)} ${pad("Updated", 12)} ${pad("Tags", 18)}`;
          out.info(brand.label(header));
          out.info(brand.label("  " + "\u2500".repeat(dividerLen)));
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
              `  ${brand.value(pad(post.title || "(untitled)", 26))} ${wsCell} ${brand.muted(pad(post.slug, slugWidth))} ${vis} ${brand.muted(pad(updated, 12))} ${tags}`,
            );
          }
        } else {
          const dividerLen = 30 + 1 + slugWidth + 1 + 12 + 1 + 14 + 1 + 20;
          const header = `  ${pad("Title", 30)} ${pad("Slug", slugWidth)} ${pad("Visibility", 12)} ${pad("Updated", 14)} ${pad("Tags", 20)}`;
          out.info(brand.label(header));
          out.info(brand.label("  " + "\u2500".repeat(dividerLen)));
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
              `  ${brand.value(pad(post.title || "(untitled)", 30))} ${brand.muted(pad(post.slug, slugWidth))} ${vis} ${brand.muted(pad(updated, 14))} ${tags}`,
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
        projectSlug: opts.all || opts.allProjects ? null : config.projectSlug ?? null,
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

function parsePositiveInt(
  raw: string | undefined,
  name: "page" | "limit",
  fallback: number,
  max?: number,
): number | { code: string; message: string } {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    return {
      code: `invalid_${name}`,
      message: `--${name} must be a positive integer${max ? ` no greater than ${max}` : ""}.`,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    return {
      code: `invalid_${name}`,
      message: `--${name} must be a positive integer${max ? ` no greater than ${max}` : ""}.`,
    };
  }
  return value;
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
