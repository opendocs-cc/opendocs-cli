import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { hashContent, loadState, saveState, stateKey } from "../lib/state.js";
import {
  listAllPosts,
  listWorkspaceProjects,
  planProjectFiles,
  resolvePullProject,
  type Project,
} from "./pull.js";

export const cloneCommand = new Command("clone")
  .description(
    "Download a workspace (or one project) into a folder you can edit and re-publish. `opendocs publish .` in that folder updates the same documents.",
  )
  .argument("[dir]", "Target folder (defaults to the workspace or project slug)")
  .option("--project <slugOrId>", "Clone only this project")
  .option("--tag <tag>", "Only documents with this tag")
  .option("--overwrite", "Replace files that already exist in the target folder")
  .action(async (dir: string | undefined, opts, cmd) => {
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
      out.spin("Listing documents...");
      const projects: Project[] = opts.project
        ? [await resolvePullProject(client, config, opts.project)]
        : await listWorkspaceProjects(client, config.workspaceId);

      const folderName = opts.project ? projects[0].slug : (config.workspaceSlug ?? "opendocs");
      const root = path.resolve(dir ?? folderName);

      const plans = [];
      for (const project of projects) {
        const posts = await listAllPosts(client, {
          workspaceId: config.workspaceId,
          projectId: project.id,
          tag: opts.tag,
        });
        plans.push(
          ...planProjectFiles({ posts, project, outputDir: root, groupByProject: !opts.project }),
        );
      }

      const existing = plans.filter((plan) => fs.existsSync(plan.targetPath));
      if (existing.length > 0 && !opts.overwrite) {
        out.stopSpinner();
        out.error({
          code: "file_exists",
          message: `${path.join(path.relative(process.cwd(), root), existing[0].relativePath)} already exists. Use --overwrite to replace files.`,
        });
        return;
      }

      fs.mkdirSync(root, { recursive: true });
      const state = loadState(root);
      state.apiUrl = config.apiUrl;
      state.workspaceId = config.workspaceId;
      state.workspaceSlug = config.workspaceSlug;
      // Cloning one project links the folder to it, so new files published
      // from here land in that project (like checking out a branch).
      if (opts.project) {
        state.project = { id: projects[0].id, slug: projects[0].slug, name: projects[0].name };
      }

      out.spin(`Cloning ${plans.length} document${plans.length === 1 ? "" : "s"}...`);
      const files = [];
      for (const plan of plans) {
        const data = await client.pullPost(plan.post.id, {
          workspaceId: config.workspaceId,
          projectId: plan.project.id,
        });
        fs.mkdirSync(path.dirname(plan.targetPath), { recursive: true });
        fs.writeFileSync(plan.targetPath, data.markdown);
        const key = stateKey(root, plan.targetPath);
        state.docs[key] = {
          postId: plan.post.id,
          slug: plan.post.slug,
          url: plan.project.isDefault
            ? `/${config.workspaceSlug}/${plan.post.slug}`
            : `/${config.workspaceSlug}/projects/${plan.project.slug}/${plan.post.slug}`,
          workspaceId: config.workspaceId,
          projectId: plan.project.id,
          projectSlug: plan.project.slug,
          versionNumber: data.versionNumber,
          localHash: hashContent(data.markdown),
          syncedAt: new Date().toISOString(),
        };
        files.push({ path: key, postId: plan.post.id, projectSlug: plan.project.slug, versionNumber: data.versionNumber });
      }
      saveState(root, state);

      const shown = path.relative(process.cwd(), root) || ".";
      out.succeed(
        `Cloned ${brand.purpleBold(String(files.length))} document${files.length === 1 ? "" : "s"} into ${brand.value(shown)}`,
      );
      out.info(
        brand.muted(
          `Edit files, then run ${brand.purple(`cd ${shown} && opendocs publish .`)} to update them. ${brand.purple("opendocs status")} shows what changed.`,
        ),
      );
      out.result({ success: true, dir: root, workspaceSlug: config.workspaceSlug, files });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
