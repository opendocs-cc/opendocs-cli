import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `.opendocs/state.json` remembers which local file is which published
 * document, so publishing the same file again updates it instead of
 * creating a duplicate, and `opendocs status` can tell what changed on
 * either side. Written by `clone`, `publish` and `pull` (when a state file
 * already exists). It also holds claim tokens for anonymous docs, so it is
 * git-ignored by default.
 */

export const STATE_DIR = ".opendocs";
export const STATE_FILE = "state.json";

export interface TrackedDoc {
  postId: string;
  slug: string;
  url: string;
  workspaceId: string;
  projectId?: string;
  projectSlug?: string;
  /** Version on the server when this file was last published or pulled. */
  versionNumber: number;
  /** SHA-256 of the file on disk at that moment. */
  localHash: string;
  syncedAt: string;
}

export interface TrackedAnonymousDoc {
  id: string;
  url: string;
  claimToken: string;
  claimUrl: string;
  expiresAt: string;
  localHash: string;
}

export interface StateFile {
  version: 1;
  apiUrl?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  /**
   * Folder → project link (`opendocs project link`), like a repo's branch:
   * new documents published from this folder go to this project unless
   * --project says otherwise.
   */
  project?: { id: string; slug: string; name: string };
  docs: Record<string, TrackedDoc>;
  anonymous: Record<string, TrackedAnonymousDoc>;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function statePath(root: string) {
  return path.join(root, STATE_DIR, STATE_FILE);
}

/** Nearest directory at or above `startDir` holding `.opendocs/state.json`. */
export function findStateRoot(startDir: string = process.cwd()): string | null {
  const home = os.homedir();
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(statePath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

export function emptyState(): StateFile {
  return { version: 1, docs: {}, anonymous: {} };
}

export function loadState(root: string): StateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(root), "utf8")) as Partial<StateFile>;
    return {
      ...emptyState(),
      ...raw,
      version: 1,
      docs: raw.docs ?? {},
      anonymous: raw.anonymous ?? {},
    };
  } catch {
    return emptyState();
  }
}

export function saveState(root: string, state: StateFile): void {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "# Local OpenDocs sync state (contains claim tokens)\n*\n");
  }
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Path of `file` relative to the state root, with forward slashes. */
export function stateKey(root: string, file: string): string {
  return path.relative(root, path.resolve(file)).split(path.sep).join("/");
}

/** Loads the nearest state, or a fresh one rooted at the current directory. */
export function openState(startDir: string = process.cwd()) {
  const existingRoot = findStateRoot(startDir);
  const root = existingRoot ?? path.resolve(startDir);
  return { root, state: existingRoot ? loadState(root) : emptyState(), existed: Boolean(existingRoot) };
}
