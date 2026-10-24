import fs from "node:fs";
import { findStateRoot, loadState, stateKey } from "./state.js";

/**
 * Commands that take `<idOrSlug>` also accept a local Markdown file this
 * folder has published or cloned (`opendocs history notes.md`), resolved
 * through `.opendocs/state.json`.
 */
export function resolveDocRef(ref: string): string {
  if (!ref.toLowerCase().endsWith(".md") || !fs.existsSync(ref)) return ref;
  const root = findStateRoot();
  if (!root) return ref;
  const tracked = loadState(root).docs[stateKey(root, ref)];
  return tracked?.postId ?? ref;
}
