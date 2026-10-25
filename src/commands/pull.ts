import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";
import { findStateRoot, hashContent, loadState, saveState, stateKey } from "../lib/state.js";

export type Client = ReturnType<typeof createApiClient>;
export type ListedPost = Awaited<ReturnType<Client["listPosts"]>>["posts"][number];
export type Project = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  isDefault: boolean;
};

export const pullCommand = new Command("pull")
  .description("Download raw markdown for a document, project, or workspace")
  .argument("[idOrSlug]", "Post ID (UUID) or slug — see `opendocs list`")
  .option("-o, --output <path>", "Output file path for one document, or output directory for bulk pulls")
  .option("--stdout", "Print markdown to stdout instead of saving")
  .option("--project [slugOrId]", "Pull the active project, or a specific project by slug/id")
  .option("--workspace", "Pull every project in the active workspace")
  .option("--tag <tag>", "Filter bulk pulls by tag")
  .option("--overwrite", "Replace existing files during bulk pulls")
  .option("--dry-run", "Show what would be written without creating files")
  .option("--version <n>", "Download an earlier version (see `opendocs history`)")
  .action(async (postId: string | undefined, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      const bulkRequested = Boolean(opts.workspace || opts.project !== undefined || opts.tag);
      if (!postId && !bulkRequested) {
        out.error({
          code: "missing_target",
          message:
            "Provide a document id/slug, or use --project, --workspace, or --tag for a bulk pull.",
        });
        return;
      }

      if (postId && bulkRequested) {
        out.error({
          code: "invalid_options",
          message: "Pull one document by id/slug, or use bulk flags without a document argument.",
        });
        return;
      }

      if (opts.workspace && opts.project !== undefined) {
        out.error({
          code: "invalid_options",
          message: "Use either --workspace or --project, not both.",
        });
        return;
      }

      if (bulkRequested) {
        if (opts.stdout) {
          out.error({
            code: "invalid_options",
            message: "--stdout is only supported when pulling one document.",
          });
          return;
        }
        await pullBulk({ opts, out, config });
        return;
      }

      out.spin(`Downloading document ${brand.muted(postId)}...`);

      const client = createApiClient(config);
      const ref = resolveDocRef(postId as string);
      const data = await client.pullPost(ref, {
        workspaceId: config.workspaceId,
        projectId: config.projectId,
      });
      const isLatest = opts.version === undefined;
      if (!isLatest) {
        const versionNumber = Number(String(opts.version).replace(/^v/i, ""));
        const version = await client.getVersionMarkdown(ref, versionNumber, {
          workspaceId: config.workspaceId,
        });
        data.markdown = version.markdown;
        data.versionNumber = version.versionNumber;
      }

      if (opts.stdout) {
        out.succeed(`Downloaded ${brand.value(data.title)} ${brand.muted(`(v${data.versionNumber})`)}`);
        if (!globalOpts.json) {
          process.stdout.write(data.markdown);
        }
        out.result(data);
        return;
      }

      const filename = opts.output || `${data.slug}.md`;
      fs.writeFileSync(filename, data.markdown);

      // Pulling the latest version into a tracked file brings it back in
      // sync, so the next publish doesn't report a conflict.
      const stateRoot = findStateRoot();
      if (isLatest && stateRoot) {
        const state = loadState(stateRoot);
        const key = stateKey(stateRoot, filename);
        const tracked = state.docs[key];
        if (tracked && tracked.postId === data.postId) {
          state.docs[key] = {
            ...tracked,
            versionNumber: data.versionNumber,
            localHash: hashContent(data.markdown),
            syncedAt: new Date().toISOString(),
          };
          saveState(stateRoot, state);
        }
      }

      out.succeed(`Downloaded ${brand.value(data.title)} ${brand.muted(`(v${data.versionNumber})`)}`);
      out.info(`${brand.label("Saved to:")} ${brand.purple(filename)}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

async function pullBulk({
  opts,
  out,
  config,
}: {
  opts: {
    output?: string;
    workspace?: boolean;
    project?: true | string;
    tag?: string;
    overwrite?: boolean;
    dryRun?: boolean;
  };
  out: ReturnType<typeof createOutput>;
  config: ReturnType<typeof getConfigOrExit>;
}) {
  if (!config.workspaceId) {
    out.error({
      code: "no_workspace",
      message: 'No active workspace. Run "opendocs login" to refresh your config.',
    });
    return;
  }

  const client = createApiClient(config);
  const outputDir = path.resolve(opts.output || ".");
  const mode = opts.workspace ? "workspace" : "project";
  out.spin(
    opts.workspace
      ? `Planning workspace pull${opts.tag ? ` for tag ${brand.value(opts.tag)}` : ""}...`
      : `Planning project pull${opts.tag ? ` for tag ${brand.value(opts.tag)}` : ""}...`,
  );

  const projects = opts.workspace
    ? await listWorkspaceProjects(client, config.workspaceId)
    : [await resolvePullProject(client, config, opts.project)];

  const plans: Array<{
    post: ListedPost;
    project: Project;
    targetPath: string;
    relativePath: string;
  }> = [];

  for (const project of projects) {
    const posts = await listAllPosts(client, {
      workspaceId: config.workspaceId,
      projectId: project.id,
      tag: opts.tag,
    });
    plans.push(
      ...planProjectFiles({
        posts,
        project,
        outputDir,
        groupByProject: Boolean(opts.workspace),
      }),
    );
  }

  const existing = plans.filter((plan) => fs.existsSync(plan.targetPath));
  if (existing.length > 0 && !opts.overwrite && !opts.dryRun) {
    out.stopSpinner();
    out.error({
      code: "file_exists",
      message: `${existing[0].relativePath} already exists. Use --overwrite to replace files.`,
    });
    return;
  }

  if (opts.dryRun) {
    out.succeed(
      `Would pull ${brand.purpleBold(String(plans.length))} document${plans.length === 1 ? "" : "s"} into ${brand.value(outputDir)}`,
    );
    for (const plan of plans) {
      const exists = fs.existsSync(plan.targetPath);
      out.info(
        `${brand.muted(exists ? "replace" : "write")} ${brand.purple(plan.relativePath)}`,
      );
    }
    out.result({
      success: true,
      dryRun: true,
      mode,
      tag: opts.tag ?? null,
      outputDir,
      files: plans.map((plan) => ({
        postId: plan.post.id,
        slug: plan.post.slug,
        projectId: plan.project.id,
        projectSlug: plan.project.slug,
        path: plan.relativePath,
        exists: fs.existsSync(plan.targetPath),
      })),
    });
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  out.spin(`Pulling ${plans.length} document${plans.length === 1 ? "" : "s"}...`);

  const files: Array<{
    postId: string;
    slug: string;
    projectId: string;
    projectSlug: string;
    path: string;
  }> = [];

  for (const plan of plans) {
    const data = await client.pullPost(plan.post.id, {
      workspaceId: config.workspaceId,
      projectId: plan.project.id,
    });
    fs.mkdirSync(path.dirname(plan.targetPath), { recursive: true });
    fs.writeFileSync(plan.targetPath, data.markdown);
    files.push({
      postId: plan.post.id,
      slug: data.slug,
      projectId: plan.project.id,
      projectSlug: plan.project.slug,
      path: plan.relativePath,
    });
  }

  out.succeed(
    `Pulled ${brand.purpleBold(String(files.length))} document${files.length === 1 ? "" : "s"} into ${brand.value(outputDir)}`,
  );
  if (files.length === 0) {
    out.info("No matching documents found.");
  } else {
    for (const file of files.slice(0, 20)) {
      out.info(`${brand.label("Saved:")} ${brand.purple(file.path)}`);
    }
    if (files.length > 20) {
      out.info(brand.muted(`...and ${files.length - 20} more`));
    }
  }
  out.result({
    success: true,
    mode,
    tag: opts.tag ?? null,
    outputDir,
    files,
  });
}

export async function listWorkspaceProjects(client: Client, workspaceId: string): Promise<Project[]> {
  const { projects } = await client.listProjects(workspaceId);
  return projects;
}

export async function resolvePullProject(
  client: Client,
  config: ReturnType<typeof getConfigOrExit>,
  ref: true | string | undefined,
): Promise<Project> {
  if (!config.workspaceId) {
    throw new Error('No active workspace. Run "opendocs login" to refresh your config.');
  }

  const { projects, defaultProject } = await client.listProjects(config.workspaceId);
  if (typeof ref === "string") {
    const project = projects.find((p) => p.id === ref || p.slug === ref);
    if (!project) throw new Error(`Project "${ref}" was not found in the active workspace.`);
    return project;
  }

  const active = config.projectId
    ? projects.find((project) => project.id === config.projectId)
    : null;
  if (active) return active;
  const fallback = defaultProject ?? projects.find((project) => project.isDefault);
  if (!fallback) throw new Error("No project found in the active workspace.");
  return fallback;
}

export async function listAllPosts(
  client: Client,
  opts: { workspaceId: string; projectId: string; tag?: string },
): Promise<ListedPost[]> {
  const posts: ListedPost[] = [];
  const limit = 100;
  let page = 1;

  while (true) {
    const data = await client.listPosts({
      page,
      limit,
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      tag: opts.tag,
    });
    posts.push(...data.posts);
    if (page >= data.pagination.totalPages || data.posts.length === 0) break;
    page += 1;
  }

  return posts;
}

export function planProjectFiles({
  posts,
  project,
  outputDir,
  groupByProject,
}: {
  posts: ListedPost[];
  project: Project;
  outputDir: string;
  groupByProject: boolean;
}) {
  const used = new Set<string>();
  return posts.map((post) => {
    const folder = groupByProject && !project.isDefault
      ? safeJoin(outputDir, "projects", sanitizePathSegment(project.slug))
      : outputDir;
    const base = sanitizePathSegment(post.slug) || "document";
    let filename = `${base}.md`;
    let targetPath = safeJoin(folder, filename);
    const keyBase = path.resolve(targetPath);

    if (used.has(keyBase)) {
      filename = `${base}-${post.id.slice(0, 8)}.md`;
      targetPath = safeJoin(folder, filename);
    }
    used.add(path.resolve(targetPath));

    return {
      post,
      project,
      targetPath,
      relativePath: path.relative(outputDir, targetPath) || filename,
    };
  });
}

function sanitizePathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+$/, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Refusing to write outside the output directory.");
  }
  return resolved;
}
