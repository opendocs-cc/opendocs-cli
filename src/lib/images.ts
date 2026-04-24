/**
 * Local-image uploader.
 *
 * When a user runs `opendocs publish docs/intro.md`, that Markdown might
 * reference images that only exist on their laptop:
 *
 *   ![Screenshot](./assets/hero.png)
 *   <img src="diagram.svg" alt="Flow" />
 *
 * We can't just send the Markdown as-is — the API server has no way to
 * resolve those paths. This module walks the Markdown, finds every local
 * image reference, uploads the bytes to R2 via the CLI's presigned-upload
 * endpoint, and returns the Markdown rewritten to point at the public
 * HTTPS URLs. Remote images (http://, https://, data:) are left alone.
 */

import fs from "node:fs";
import path from "node:path";
import type { Buffer } from "node:buffer";
import { ApiError } from "./api.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_IMAGES_PER_DOC = 30; // sanity cap

// Content-type guess by extension. Keep this aligned with the server-side
// MIME whitelist in packages/shared/src/storage/r2.ts — anything we add
// here must also be accepted there.
const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export interface ImageUploader {
  presignImageUpload(body: {
    workspaceId: string;
    contentType: string;
    contentLength: number;
    filename?: string;
  }): Promise<{
    uploadUrl: string;
    publicUrl: string;
    key: string;
    expiresInSeconds: number;
    maxBytes?: number;
  }>;
  uploadToSignedUrl(
    uploadUrl: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void>;
}

export interface ImageUploadReport {
  uploaded: Array<{ original: string; url: string; bytes: number }>;
  skipped: Array<{ original: string; reason: string }>;
}

/**
 * Pull out every local image reference from a Markdown string.
 *
 * Matches:
 *   - `![alt](path)` — standard Markdown image
 *   - `<img src="path" ... />` — raw HTML
 *
 * Skips anything that looks remote or inlined (http, https, //, data:).
 * Returns unique refs; a reference used twice is only uploaded once.
 */
export function findLocalImageRefs(markdown: string): string[] {
  const refs = new Set<string>();

  // ![alt](./foo.png) or ![alt](foo.png "title")
  // We stop at the first whitespace, close paren, or angle bracket so we
  // don't swallow trailing title attributes.
  const mdRe = /!\[[^\]]*\]\(\s*<?([^\s)<>]+)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(markdown)) !== null) {
    const ref = m[1].trim();
    if (isLocal(ref)) refs.add(ref);
  }

  // <img src="..."> — allow single or double quotes
  const htmlRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(markdown)) !== null) {
    const ref = m[1].trim();
    if (isLocal(ref)) refs.add(ref);
  }

  return Array.from(refs);
}

function isLocal(ref: string): boolean {
  if (!ref) return false;
  if (ref.startsWith("http://") || ref.startsWith("https://")) return false;
  if (ref.startsWith("//")) return false;
  if (ref.startsWith("data:")) return false;
  // `#anchor` or `mailto:` aren't images but guard anyway.
  if (ref.startsWith("#") || ref.startsWith("mailto:")) return false;
  return true;
}

/**
 * Resolve a Markdown image reference to an absolute file path on disk.
 *
 * Security: callers must still verify the resolved file stays inside the
 * source file's directory before reading it. That keeps
 * `![](../../private.png)` from slurping up files outside the doc tree.
 */
function resolveLocalPath(ref: string, sourceFile: string): string {
  const sourceDir = path.dirname(path.resolve(sourceFile));
  const abs = path.resolve(sourceDir, ref);
  return abs;
}

function isInsideSourceDir(filePath: string, sourceFile: string): boolean {
  try {
    const sourceDir = fs.realpathSync(path.dirname(path.resolve(sourceFile)));
    const target = fs.realpathSync(filePath);
    const rel = path.relative(sourceDir, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function mimeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Walks the Markdown, uploads every local image it finds, and returns a
 * rewritten Markdown string plus a per-image report.
 *
 * Errors for individual images are collected into `skipped` rather than
 * thrown — we'd rather publish the doc with one broken image than reject
 * the whole batch for a missing file. The caller gets a full report so
 * they can surface warnings to the user.
 */
export async function uploadLocalImagesAndRewrite(args: {
  markdown: string;
  sourceFile: string;
  client: ImageUploader;
  workspaceId: string;
}): Promise<{ markdown: string; report: ImageUploadReport }> {
  const { markdown, sourceFile, client, workspaceId } = args;

  const refs = findLocalImageRefs(markdown);
  const report: ImageUploadReport = { uploaded: [], skipped: [] };

  if (refs.length === 0) {
    return { markdown, report };
  }

  if (refs.length > MAX_IMAGES_PER_DOC) {
    // Bail defensively — if someone accidentally globs half their laptop,
    // we'd rather fail fast than burn their bandwidth.
    throw new Error(
      `This document references ${refs.length} local images, but the cap is ${MAX_IMAGES_PER_DOC}. Move some images to a remote host or split the document.`,
    );
  }

  const replacements = new Map<string, string>();

  for (const ref of refs) {
    const abs = resolveLocalPath(ref, sourceFile);

    if (!fs.existsSync(abs)) {
      report.skipped.push({ original: ref, reason: "file not found" });
      continue;
    }

    if (!isInsideSourceDir(abs, sourceFile)) {
      report.skipped.push({
        original: ref,
        reason: "outside the document directory",
      });
      continue;
    }

    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      report.skipped.push({ original: ref, reason: "not a regular file" });
      continue;
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      report.skipped.push({
        original: ref,
        reason: `file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; cap is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      });
      continue;
    }

    const mime = mimeForPath(abs);
    if (!mime) {
      report.skipped.push({
        original: ref,
        reason: `unsupported extension (${path.extname(abs) || "none"})`,
      });
      continue;
    }

    try {
      const body = fs.readFileSync(abs);
      const { uploadUrl, publicUrl } = await client.presignImageUpload({
        workspaceId,
        contentType: mime,
        contentLength: stat.size,
        filename: path.basename(abs),
      });
      await client.uploadToSignedUrl(uploadUrl, body, mime);
      replacements.set(ref, publicUrl);
      report.uploaded.push({
        original: ref,
        url: publicUrl,
        bytes: stat.size,
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "upload failed";
      report.skipped.push({ original: ref, reason: msg });
    }
  }

  if (replacements.size === 0) {
    return { markdown, report };
  }

  const rewritten = rewriteMarkdown(markdown, replacements);
  return { markdown: rewritten, report };
}

/**
 * Replace every occurrence of a local image ref with its uploaded URL,
 * matching both `![alt](ref)` and `<img src="ref">` forms. Only swaps the
 * exact same token we matched when we harvested refs, so text bodies with
 * coincidental substrings are safe.
 */
function rewriteMarkdown(
  markdown: string,
  replacements: Map<string, string>,
): string {
  let result = markdown;

  for (const [original, url] of replacements) {
    // ![alt](original) → ![alt](url)   (preserve alt + optional title)
    const escaped = escapeRegExp(original);
    const mdRe = new RegExp(
      `(!\\[[^\\]]*\\]\\(\\s*<?)${escaped}(\\s*(?:"[^"]*")?\\s*\\))`,
      "g",
    );
    result = result.replace(mdRe, `$1${url}$2`);

    // <img src="original"> or <img src='original'>
    const htmlReDouble = new RegExp(
      `(<img\\b[^>]*\\bsrc\\s*=\\s*")${escaped}(")`,
      "gi",
    );
    const htmlReSingle = new RegExp(
      `(<img\\b[^>]*\\bsrc\\s*=\\s*')${escaped}(')`,
      "gi",
    );
    result = result.replace(htmlReDouble, `$1${url}$2`);
    result = result.replace(htmlReSingle, `$1${url}$2`);
  }

  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
