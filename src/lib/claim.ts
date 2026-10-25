import fs from "node:fs";
import path from "node:path";
import type { CliConfig } from "./config.js";
import type { createApiClient } from "./api.js";
import { brand, type Output } from "./output.js";
import { hashContent, openState, saveState } from "./state.js";

type Client = ReturnType<typeof createApiClient>;

/**
 * Claims every anonymous doc recorded in the nearest `.opendocs/state.json`
 * into the active workspace/project, and re-tracks each source file as the
 * new post so later publishes update it. Expired or already-claimed docs
 * are dropped from state. Returns what happened per file.
 */
export async function claimTrackedAnonymousDocs(
  client: Client,
  config: CliConfig,
  out: Output,
): Promise<Array<{ file: string; success: boolean; url?: string; postId?: string; message?: string }>> {
  const { root, state, existed } = openState();
  const entries = Object.entries(state.anonymous);
  if (!existed || entries.length === 0 || !config.workspaceId) return [];

  const results: Array<{ file: string; success: boolean; url?: string; postId?: string; message?: string }> = [];
  for (const [file, anon] of entries) {
    try {
      const post = await client.claimAnonymous({
        claimToken: anon.claimToken,
        workspaceId: config.workspaceId,
        ...(config.projectId ? { projectId: config.projectId } : {}),
      });
      const absolute = path.join(root, file);
      const localHash = fs.existsSync(absolute)
        ? hashContent(fs.readFileSync(absolute, "utf8"))
        : anon.localHash;
      state.docs[file] = {
        postId: post.postId,
        slug: post.slug,
        url: post.url,
        workspaceId: config.workspaceId,
        projectId: config.projectId,
        projectSlug: post.projectSlug,
        versionNumber: post.versionNumber,
        localHash,
        syncedAt: new Date().toISOString(),
      };
      delete state.anonymous[file];
      results.push({ file, success: true, url: post.url, postId: post.postId });
      out.info(`${brand.success("✔")} Claimed ${brand.value(file)} → ${brand.url(post.publicUrl ? post.publicUrl.replace(/^https?:\/\//, "") : `opendocs.cc${post.url}`)}`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 404 || e.status === 410) delete state.anonymous[file];
      results.push({ file, success: false, message: e.message });
      out.warn(`Could not claim ${file}: ${e.message ?? "unknown error"}`);
    }
  }
  state.workspaceId ??= config.workspaceId;
  state.workspaceSlug ??= config.workspaceSlug;
  saveState(root, state);
  return results;
}
