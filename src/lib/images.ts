/**
 * Local-image uploader.
 *
 * When a user runs `opendocs publish docs/intro.md`, that Markdown might
 * reference images that only exist on their laptop:
 *
 *   ![Screenshot](./assets/hero.png)
 *   <img src="diagram.svg" alt="Flow" />
 *   ![Chart][chart]
 *   [chart]: ./assets/chart.webp "Quarterly numbers"
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
 *   - `[label]: path` — link reference definitions (outside fenced code)
 *     that are used by a reference-style image (`![alt][label]`,
 *     `![label][]`, `![label]`) or whose target has an image extension
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

  // [label]: ./foo.png "title" — reference-style image definitions
  for (const def of findImageReferenceDefinitions(markdown)) {
    refs.add(def.target);
  }

  return Array.from(refs);
}

/**
 * A link reference definition line, split so the target can be swapped
 * without disturbing anything else on the line.
 */
interface ReferenceDefinition {
  lineIndex: number;
  /** Normalized label (see `normalizeLabel`). */
  label: string;
  /** Everything up to and including `]:` plus following whitespace. */
  prefix: string;
  /** The target with any `<...>` wrapping removed. */
  target: string;
  /** Whether the target was written as `<target>`. */
  bracketed: boolean;
  /** Optional title and trailing whitespace (incl. a stray `\r`). */
  rest: string;
}

// Optional blockquote markers, up to 3 spaces of indent, `[label]:`, then
// the destination (either `<...>` or a run of non-whitespace) and an
// optional title. Footnote definitions (`[^1]: ...`) are excluded.
const REF_DEF_RE =
  /^((?:[ ]{0,3}>[ ]?)*[ ]{0,3}\[([^\]\n]*[^\]\s][^\]\n]*)\]:[ \t]*)(?:<([^<>\n]*)>|([^\s<][^\s]*))([^\n]*)$/;
// What may follow the destination on the same line: nothing, or a title in
// "double quotes", 'single quotes' or (parens).
const REF_DEF_REST_RE = /^(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t\r]*$/;
const FENCE_RE = /^(?:[ ]{0,3}>[ ]?)*[ ]{0,3}(`{3,}|~{3,})([^\n]*)$/;

/** CommonMark label matching: case-insensitive, whitespace-collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Parse every link reference definition outside fenced code blocks.
 */
function parseReferenceDefinitions(markdown: string): ReferenceDefinition[] {
  const lines = markdown.split("\n");
  const inCode = fencedCodeLines(lines);
  const defs: ReferenceDefinition[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (inCode[i]) continue;
    const m = REF_DEF_RE.exec(lines[i]);
    if (!m) continue;
    const label = m[2];
    if (label.startsWith("^")) continue; // footnote definition
    const rest = m[5];
    if (!REF_DEF_REST_RE.test(rest)) continue;
    const bracketed = m[3] !== undefined;
    defs.push({
      lineIndex: i,
      prefix: m[1],
      target: (bracketed ? m[3] : m[4]).trim(),
      bracketed,
      rest,
      label: normalizeLabel(label),
    });
  }

  return defs;
}

/**
 * Labels referenced by reference-style images outside fenced code:
 * full `![alt][label]`, collapsed `![label][]` and shortcut `![label]`.
 */
function findImageReferenceLabels(markdown: string): Set<string> {
  const labels = new Set<string>();
  const text = stripFencedCode(markdown);
  const re = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?!\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = m[2] && m[2].trim() !== "" ? m[2] : m[1];
    if (label.trim() !== "") labels.add(normalizeLabel(label));
  }
  return labels;
}

/**
 * Flag each line that belongs to a fenced code block (including the fence
 * lines themselves). An unclosed fence runs to the end of the document,
 * as in CommonMark.
 */
function fencedCodeLines(lines: string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fm = FENCE_RE.exec(lines[i]);
    if (fence) {
      inCode[i] = true;
      // Closing fence: same char, at least as long, nothing else after it.
      if (
        fm &&
        fm[1][0] === fence.char &&
        fm[1].length >= fence.len &&
        fm[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    // A backtick fence's info string may not contain backticks.
    if (fm && !(fm[1][0] === "`" && fm[2].includes("`"))) {
      fence = { char: fm[1][0], len: fm[1].length };
      inCode[i] = true;
    }
  }
  return inCode;
}

/** Blank out fenced code block lines so regex scans skip them. */
function stripFencedCode(markdown: string): string {
  const lines = markdown.split("\n");
  const inCode = fencedCodeLines(lines);
  return lines.map((line, i) => (inCode[i] ? "" : line)).join("\n");
}

/**
 * Reference definitions whose target is a local file and that are either
 * used by a reference-style image or point at an image-extension file.
 * Definitions inside fenced code blocks and remote targets are ignored.
 */
function findImageReferenceDefinitions(
  markdown: string,
): ReferenceDefinition[] {
  const defs = parseReferenceDefinitions(markdown);
  if (defs.length === 0) return [];
  const usedLabels = findImageReferenceLabels(markdown);
  return defs.filter((def) => {
    if (!isLocal(def.target)) return false;
    return usedLabels.has(def.label) || mimeForPath(def.target) !== null;
  });
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
  let result = rewriteReferenceDefinitions(markdown, replacements);

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

/**
 * Swap the target of each matching reference definition for its uploaded
 * URL, preserving the label, indentation, angle brackets and title.
 */
function rewriteReferenceDefinitions(
  markdown: string,
  replacements: Map<string, string>,
): string {
  const defs = findImageReferenceDefinitions(markdown).filter((def) =>
    replacements.has(def.target),
  );
  if (defs.length === 0) return markdown;

  const lines = markdown.split("\n");
  for (const def of defs) {
    const url = replacements.get(def.target)!;
    const target = def.bracketed ? `<${url}>` : url;
    lines[def.lineIndex] = `${def.prefix}${target}${def.rest}`;
  }
  return lines.join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
