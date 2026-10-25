import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";
import { findStateRoot, loadState, saveState } from "../lib/state.js";
import { postDisplayUrl, resolveOrCreateProject } from "./publish-sync.js";

export const moveCommand = new Command("move")
  .description("Move a document to another project (its URL changes; content is untouched)")
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .requiredOption(
    "--project <nameOrSlug>",
    "Target project name, slug or ID (created if the name is new)",
  )
  .action(async (ref: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
    if (!config.workspaceId) {
      out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
      return;
    }

    try {
      const client = createApiClient(config);
      const project = await resolveOrCreateProject(client, config.workspaceId, opts.project, out);
      out.spin(`Moving to ${brand.value(project.name)}...`);
      const postId = resolveDocRef(ref);
      const result = await client.movePost(postId, { projectId: project.id }, {
        workspaceId: config.workspaceId,
      });

      const root = findStateRoot();
      if (root) {
        const state = loadState(root);
        for (const doc of Object.values(state.docs)) {
          if (doc.postId === result.postId) {
            doc.projectId = result.projectId;
            doc.projectSlug = result.projectSlug;
            doc.slug = result.slug;
            doc.url = result.url;
          }
        }
        saveState(root, state);
      }

      if (result.moved) {
        out.succeed(`Moved to ${brand.value(result.projectName)} → ${brand.url(postDisplayUrl(result))}`);
        if (result.previousSlug && result.previousSlug !== result.slug) {
          out.warn(`The slug changed to "${result.slug}" because "${result.previousSlug}" was taken in that project.`);
        }
      } else {
        out.succeed(`Already in ${brand.value(result.projectName)}`);
      }
      out.result(result);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
