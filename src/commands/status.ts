import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { findStateRoot, hashContent, loadState, STATE_DIR } from "../lib/state.js";

type FileStatus =
  | "up-to-date"
  | "modified"
  | "behind"
  | "conflict"
  | "missing-locally"
  | "gone-remotely"
  | "untracked"
  | "anonymous";

const SKIP_DIRS = new Set([".git", ".hg", ".obsidian", ".trash", "node_modules", STATE_DIR]);

function walkMarkdown(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return results.sort();
}

const LABELS: Record<FileStatus, string> = {
  "up-to-date": brand.muted("up to date"),
  modified: brand.warn("modified locally"),
  behind: brand.purple("newer version online"),
  conflict: brand.error("changed locally and online"),
  "missing-locally": brand.error("file deleted locally"),
  "gone-remotely": brand.error("no longer online"),
  untracked: brand.success("new (not published)"),
  anonymous: brand.warn("anonymous"),
};

export const statusCommand = new Command("status")
  .description("Show which files changed locally or online since the last publish, pull or clone")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    const root = findStateRoot();
    if (!root) {
      out.error({
        code: "no_state",
        message:
          "This folder isn't linked to OpenDocs yet. Run `opendocs clone` to download a workspace, or `opendocs publish <files>` here first.",
      });
      return;
    }

    try {
      const state = loadState(root);
      const client = createApiClient(config);
      out.spin("Checking documents...");

      const remote = new Map<string, number | null>();
      const workspaceIds = new Set(Object.values(state.docs).map((d) => d.workspaceId));
      for (const workspaceId of workspaceIds) {
        let page = 1;
        while (true) {
          const data = await client.listPosts({ workspaceId, page, limit: 100 });
          for (const post of data.posts) {
            if (post.isPublished) remote.set(post.id, post.versionNumber ?? null);
          }
          if (page >= data.pagination.totalPages || data.posts.length === 0) break;
          page += 1;
        }
      }
      out.stopSpinner();

      const files: Array<{
        path: string;
        status: FileStatus;
        postId?: string;
        localVersion?: number;
        remoteVersion?: number | null;
        url?: string;
        expiresAt?: string;
      }> = [];

      for (const [key, doc] of Object.entries(state.docs)) {
        const absolute = path.join(root, key);
        if (!fs.existsSync(absolute)) {
          files.push({ path: key, status: "missing-locally", postId: doc.postId, localVersion: doc.versionNumber });
          continue;
        }
        const changedLocally = hashContent(fs.readFileSync(absolute, "utf8")) !== doc.localHash;
        if (!remote.has(doc.postId)) {
          files.push({ path: key, status: "gone-remotely", postId: doc.postId, localVersion: doc.versionNumber });
          continue;
        }
        const remoteVersion = remote.get(doc.postId) ?? null;
        const changedRemotely = remoteVersion !== null && remoteVersion > doc.versionNumber;
        files.push({
          path: key,
          status: changedLocally && changedRemotely
            ? "conflict"
            : changedLocally
              ? "modified"
              : changedRemotely
                ? "behind"
                : "up-to-date",
          postId: doc.postId,
          localVersion: doc.versionNumber,
          remoteVersion,
          url: doc.url,
        });
      }

      for (const [key, anon] of Object.entries(state.anonymous)) {
        files.push({ path: key, status: "anonymous", url: anon.url, expiresAt: anon.expiresAt });
      }

      const known = new Set([...Object.keys(state.docs), ...Object.keys(state.anonymous)]);
      for (const key of walkMarkdown(root)) {
        if (!known.has(key)) files.push({ path: key, status: "untracked" });
      }

      files.sort((a, b) => a.path.localeCompare(b.path));
      const counts = files.reduce<Record<string, number>>((acc, f) => {
        acc[f.status] = (acc[f.status] ?? 0) + 1;
        return acc;
      }, {});

      const shownRoot = path.relative(process.cwd(), root) || ".";
      out.info(`${brand.label("Folder:")} ${brand.value(shownRoot)} ${brand.muted(state.workspaceSlug ? `→ opendocs.cc/${state.workspaceSlug}` : "")}`);
      for (const file of files) {
        const version =
          file.status === "behind" || file.status === "conflict"
            ? brand.muted(` (v${file.localVersion} → v${file.remoteVersion})`)
            : "";
        out.info(`${LABELS[file.status].padEnd(30)} ${file.path}${version}`);
      }
      if (files.every((f) => f.status === "up-to-date")) {
        out.succeed("Everything is up to date.");
      } else {
        if (counts.modified || counts.untracked) {
          out.info(brand.muted(`Publish changes: ${brand.purple("opendocs publish .")}`));
        }
        if (counts.behind || counts.conflict) {
          out.info(
            brand.muted(
              `Get newer versions: ${brand.purple("opendocs pull <file> -o <file>")}, or overwrite them with ${brand.purple("opendocs publish . --force")}`,
            ),
          );
        }
      }

      out.result({ root, workspaceSlug: state.workspaceSlug, files, summary: counts });
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
