import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

/**
 * `opendocs search <words>`: find documents by words in their title or
 * summary, across every project in the active workspace (the same search
 * as the MCP server's list_documents). Results carry the document ID,
 * since a slug lookup only sees the active project.
 */
export const searchCommand = new Command("search")
  .description("Find documents by words in their title or summary, across every project in the active workspace")
  .argument("<words...>", "Words to find, matched as one phrase (e.g. `acme nda`)")
  .option("--project <slugOrId>", "Only search one project")
  .option("--all", "Search every workspace you belong to")
  .option("--limit <limit>", "Most results to show (max 100)", "20")
  .action(async (words: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    const query = words.join(" ").trim().slice(0, 200);
    if (!query) {
      out.error({ code: "missing_query", message: "Give the words to search for, e.g. `opendocs search acme nda`." });
      return;
    }
    const limit = Number(opts.limit);
    if (!/^\d+$/.test(String(opts.limit)) || limit < 1 || limit > 100) {
      out.error({ code: "invalid_limit", message: "--limit must be a positive integer no greater than 100." });
      return;
    }

    try {
      const client = createApiClient(config);
      const workspaceId = opts.all ? undefined : config.workspaceId;
      let projectId: string | undefined;
      let scopeLabel = opts.all ? "all workspaces" : (config.workspaceName ?? config.workspaceSlug ?? "the active workspace");
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
        scopeLabel = `${scopeLabel} / ${match.name}`;
      }

      out.spin(`Searching ${scopeLabel} for "${query}"...`);
      const data = await client.listPosts({ q: query, limit, workspaceId, projectId });
      const { posts, pagination } = data;

      if (posts.length === 0) {
        out.succeed(`No documents in ${scopeLabel} match "${query}".`);
        out.info(
          brand.muted(
            `  Search matches titles and summaries. Try fewer or other words, or ${brand.purple("opendocs list --all-projects")} to see everything.`,
          ),
        );
      } else {
        out.succeed(
          `${brand.purpleBold(String(pagination.total))} document(s) in ${scopeLabel} match "${query}"${pagination.total > posts.length ? ` (showing ${posts.length})` : ""}`,
        );
        for (const post of posts) {
          out.info("");
          out.info(`  ${brand.value(post.title || "(untitled)")}`);
          out.info(
            brand.muted(
              `  ${opts.all ? `${post.workspaceSlug} / ` : ""}${post.projectName} · ${post.visibility} · ${post.id}`,
            ),
          );
          if (post.summary) out.info(`  ${post.summary}`);
        }
        out.info("");
        out.info(brand.muted(`  Read one with ${brand.purple("opendocs pull <id> --stdout")}.`));
      }

      out.result({
        query,
        posts,
        pagination,
        scope: opts.all ? "all" : "workspace",
        workspaceSlug: opts.all ? null : (config.workspaceSlug ?? null),
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
