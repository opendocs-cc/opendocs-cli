import path from "node:path";
import type { CliConfig } from "../lib/config.js";
import { ApiError, createApiClient } from "../lib/api.js";
import { brand, type Output } from "../lib/output.js";
import { uploadLocalImagesAndRewrite } from "../lib/images.js";
import { hashContent, stateKey, type StateFile } from "../lib/state.js";

type Client = ReturnType<typeof createApiClient>;

export const MAX_ANONYMOUS_FILES = 10;

/**
 * The link to show for a post: its custom-domain URL when the API sends one
 * (`publicUrl`), otherwise its opendocs.cc path. Without the scheme, like
 * `displayUrl`.
 */
export function postDisplayUrl(post: { url?: string | null; publicUrl?: string | null }, fallback = ""): string {
  return displayUrl(post.publicUrl ?? post.url ?? fallback);
}

/** The same link with its scheme, for JSON output. */
export function postPublicUrl(post: { url?: string | null; publicUrl?: string | null }, fallback = ""): string {
  return post.publicUrl ?? `https://${displayUrl(post.url ?? fallback)}`;
}

export function displayUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url.replace(/^https?:\/\//, "");
  }
  return `opendocs.cc${url.startsWith("/") ? url : `/${url}`}`;
}

function hoursLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000));
}

/**
 * Publishes (or re-publishes) files without an account. Each file becomes
 * an anonymous doc readable by anyone with its link for 24 hours. Files
 * already published anonymously from this folder are updated in place
 * using the claim token in `.opendocs/state.json`.
 */
export async function publishAnonymously({
  docs,
  apiUrl,
  title,
  root,
  state,
  out,
}: {
  docs: Array<{ file: string; content: string }>;
  apiUrl: string;
  title?: string;
  root: string;
  state: StateFile;
  out: Output;
}) {
  const client = createApiClient({ apiKey: "", apiUrl });
  const results: Array<Record<string, unknown>> = [];

  for (const { file, content } of docs) {
    const key = stateKey(root, file);
    const existing = state.anonymous[key];
    out.spin(`Publishing ${brand.value(path.basename(file))} anonymously...`);
    try {
      let doc: { id: string; url: string; expiresAt: string; claimUrl: string; claimToken: string };
      let action: "created" | "updated" = "created";
      if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
        const updated = await client.updateAnonymous(existing.id, {
          markdown: content,
          title,
          claimToken: existing.claimToken,
        });
        doc = { ...existing, url: updated.url, expiresAt: updated.expiresAt };
        action = "updated";
      } else {
        doc = await client.publishAnonymous({ markdown: content, title });
      }
      state.anonymous[key] = {
        id: doc.id,
        url: doc.url,
        claimToken: doc.claimToken,
        claimUrl: doc.claimUrl,
        expiresAt: doc.expiresAt,
        localHash: hashContent(content),
      };
      out.succeed(`${action === "created" ? "Published" : "Updated"} ${brand.value(path.basename(file))} ${brand.muted(`(anonymous, expires in ${hoursLeft(doc.expiresAt)}h)`)}`);
      out.info(`${brand.label("URL:")}   ${brand.url(doc.url)}`);
      out.info(`${brand.label("Claim:")} ${brand.url(doc.claimUrl)}`);
      results.push({
        file,
        success: true,
        action,
        anonymous: true,
        id: doc.id,
        url: doc.url,
        claimUrl: doc.claimUrl,
        expiresAt: doc.expiresAt,
      });
    } catch (err) {
      out.stopSpinner();
      const e = err as { code?: string; message?: string };
      out.info(`${brand.error("✖")} ${brand.value(path.basename(file))} — ${e.message ?? "failed"}`);
      results.push({ file, success: false, error: e.code ?? "publish_failed", message: e.message });
    }
  }

  out.info("");
  out.info(
    `Anonymous links work for 24 hours. To keep them, run ${brand.purple("opendocs login --email you@example.com")} in this folder: they are claimed into your new workspace automatically.`,
  );
  return results;
}

export type TrackedUpdateResult = {
  file: string;
  success: boolean;
  action: "updated" | "unchanged" | "conflict" | "failed";
  postId: string;
  url?: string;
  publicUrl?: string;
  versionNumber?: number;
  currentVersionNumber?: number;
  error?: string;
  message?: string;
};

/**
 * Updates documents this folder already published (found in state), so a
 * second `opendocs publish notes.md` replaces the doc instead of creating
 * `notes-2`. Sends the last-synced version as `baseVersionNumber` unless
 * `force`, so a teammate's newer edit produces a conflict, not a silent
 * overwrite.
 */
export async function updateTrackedDocs({
  docs,
  client,
  config,
  root,
  state,
  out,
  force,
  overrides,
}: {
  docs: Array<{ file: string; content: string }>;
  client: Client;
  config: CliConfig;
  root: string;
  state: StateFile;
  out: Output;
  force: boolean;
  overrides: {
    title?: string;
    visibility?: string;
    tags?: string[];
    projectId?: string;
    confirmPublic?: boolean;
  };
}): Promise<TrackedUpdateResult[]> {
  const results: TrackedUpdateResult[] = [];

  for (const { file, content } of docs) {
    const key = stateKey(root, file);
    const tracked = state.docs[key]!;
    out.spin(`Updating ${brand.value(path.basename(file))}...`);

    let markdown = content;
    try {
      const { markdown: rewritten, report } = await uploadLocalImagesAndRewrite({
        markdown: content,
        sourceFile: file,
        client,
        workspaceId: tracked.workspaceId,
      });
      markdown = rewritten;
      for (const s of report.skipped) out.warn(`Image skipped: ${s.original} — ${s.reason}`);
    } catch (err) {
      const e = err as { status?: number };
      if (e.status !== 503) throw err;
    }

    try {
      const result = await client.update(
        tracked.postId,
        {
          markdown,
          workspaceId: tracked.workspaceId,
          ...(overrides.title ? { title: overrides.title } : {}),
          ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
          ...(overrides.tags ? { tags: overrides.tags } : {}),
          ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
          ...(overrides.confirmPublic ? { confirmPublic: true } : {}),
          ...(force ? {} : { baseVersionNumber: tracked.versionNumber }),
        },
        { workspaceId: tracked.workspaceId },
      );
      const url = result.url ?? tracked.url;
      const shown = postDisplayUrl(result, tracked.url);
      state.docs[key] = {
        ...tracked,
        slug: result.slug,
        url,
        projectSlug: result.projectSlug ?? tracked.projectSlug,
        versionNumber: result.versionNumber,
        localHash: hashContent(content),
        syncedAt: new Date().toISOString(),
      };
      if (result.unchanged) {
        out.succeed(`${brand.value(path.basename(file))} is unchanged ${brand.muted(`(v${result.versionNumber})`)} → ${brand.url(shown)}`);
      } else {
        out.succeed(`Updated ${brand.value(path.basename(file))} to ${brand.value(`v${result.versionNumber}`)} → ${brand.url(shown)}`);
      }
      results.push({
        file,
        success: true,
        action: result.unchanged ? "unchanged" : "updated",
        postId: tracked.postId,
        url: shown,
        publicUrl: postPublicUrl(result, url),
        versionNumber: result.versionNumber,
      });
    } catch (err) {
      out.stopSpinner();
      if (err instanceof ApiError && err.code === "version_conflict") {
        const current = Number(err.details.currentVersionNumber);
        out.info(
          `${brand.warn("⚠")} ${brand.value(path.basename(file))}: someone published v${current} since your copy (v${tracked.versionNumber}). Review it with ${brand.purple(`opendocs pull ${tracked.postId} --stdout`)}, then re-run with ${brand.purple("--force")} to overwrite.`,
        );
        results.push({
          file,
          success: false,
          action: "conflict",
          postId: tracked.postId,
          currentVersionNumber: current,
          error: "version_conflict",
          message: err.message,
        });
        continue;
      }
      const e = err as { code?: string; message?: string };
      out.info(`${brand.error("✖")} ${brand.value(path.basename(file))} — ${e.message ?? "update failed"}`);
      results.push({
        file,
        success: false,
        action: "failed",
        postId: tracked.postId,
        error: e.code ?? "update_failed",
        message: e.message,
      });
    }
  }

  return results;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds a project by id or slug, or creates it when `ref` is a name that
 * doesn't exist yet (`--project "Client X"` just works the first time).
 */
export async function resolveOrCreateProject(
  client: Client,
  workspaceId: string,
  ref: string,
  out: Output,
): Promise<{ id: string; slug: string; name: string; created: boolean }> {
  const { projects } = await client.listProjects(workspaceId);
  const lowered = ref.trim().toLowerCase();
  const match = projects.find(
    (p) => p.id === ref || p.slug === lowered || p.name.toLowerCase() === lowered,
  );
  if (match) return { id: match.id, slug: match.slug, name: match.name, created: false };
  if (UUID_RE.test(ref)) {
    throw new ApiError(404, "project_not_found", `Project "${ref}" was not found in the active workspace.`);
  }
  const { project } = await client.createProject({ workspaceId, name: ref.trim() });
  out.info(`${brand.success("✔")} Created project ${brand.value(project.name)} ${brand.muted(`(${project.slug})`)}`);
  return { id: project.id, slug: project.slug, name: project.name, created: true };
}
