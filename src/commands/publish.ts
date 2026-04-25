import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { readMarkdownFile } from "../lib/markdown.js";
import { uploadLocalImagesAndRewrite } from "../lib/images.js";

// Keep these in sync with the server's batchPublishInputSchema
// (opendocs/packages/shared/src/posts/validation.ts).
const MAX_BYTES_PER_DOC = 1_000_000; // 1 MB markdown cap
const MAX_FILES_PER_INVOCATION = 500; // CLI safety cap for vault uploads
const BATCH_SIZE = 25; // server enforces this too
const EXPORT_BATCH_SIZE = 10; // converter-heavy export endpoint stays lower
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".obsidian",
  ".trash",
  "node_modules",
]);

function toCliPath(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

function sourcePathFor(filePath: string): string {
  return toCliPath(path.resolve(process.cwd(), filePath));
}

function collectMarkdownFilesFromDirectory(dirPath: string): string[] {
  const root = path.resolve(process.cwd(), dirPath);
  const results: string[] = [];

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        walk(path.join(current, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      results.push(toCliPath(path.join(current, entry.name)));
    }
  }

  walk(root);
  return results;
}

function expandPublishInputs(inputs: string[]): {
  files: string[];
  expandedDirectoryCount: number;
} {
  const seen = new Set<string>();
  const files: string[] = [];
  let expandedDirectoryCount = 0;

  const addFile = (file: string) => {
    const absolute = path.resolve(process.cwd(), file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    files.push(file);
  };

  for (const input of inputs) {
    const absolute = path.resolve(process.cwd(), input);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      expandedDirectoryCount++;
      for (const file of collectMarkdownFilesFromDirectory(input)) {
        addFile(file);
      }
      continue;
    }

    addFile(input);
  }

  return { files, expandedDirectoryCount };
}

function safeServerFilename(filename: string): string | null {
  if (!filename || filename.includes("\0")) return null;
  if (path.isAbsolute(filename)) return null;
  if (filename.includes("/") || filename.includes("\\")) return null;
  const base = path.basename(filename);
  if (base !== filename || base === "." || base === "..") return null;
  return base;
}

export const publishCommand = new Command("publish")
  .description("Publish one or more Markdown files to OpenDocs")
  .argument(
    "<files...>",
    "Path(s) to .md file(s) or folder(s). Folders are scanned recursively and auto-chunked in groups of 25.",
  )
  .option("--title <title>", "Override document title (single-file only)")
  .option("--slug <slug>", "Custom URL slug (single-file only)")
  .option(
    "--visibility <visibility>",
    "private | workspace | public",
    "workspace",
  )
  .option(
    "--tags <tags>",
    "Comma-separated tags (applied to every file when publishing multiple)",
  )
  .option("--confirm-public", "Confirm public publishing")
  .option(
    "--export <format>",
    "After publishing, convert each doc and save next to the source file (docx | pdf)",
  )
  .action(async (files: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    if (!config.workspaceId) {
      out.error({
        code: "no_workspace",
        message:
          'No workspace found. Run "opendocs login" to refresh your config.',
      });
      return;
    }

    const { files: expandedFiles, expandedDirectoryCount } =
      expandPublishInputs(files);

    if (expandedDirectoryCount > 0 && expandedFiles.length === 0) {
      out.error({
        code: "no_markdown_files",
        message:
          "No .md files found in the provided folder. OpenDocs skips .obsidian, .trash, .git, and node_modules directories.",
      });
      return;
    }

    files = expandedFiles;

    // ── Pre-flight (fail before any network call) ────────────────────────
    if (files.length > MAX_FILES_PER_INVOCATION) {
      out.error({
        code: "too_many_files",
        message: `Got ${files.length} files; max is ${MAX_FILES_PER_INVOCATION} per invocation. Split into smaller groups.`,
      });
      return;
    }

    // --export must be docx or pdf if set. Commander passes arbitrary strings.
    if (opts.export && opts.export !== "docx" && opts.export !== "pdf") {
      out.error({
        code: "invalid_format",
        message: `Invalid --export: ${opts.export}. Use "docx" or "pdf".`,
      });
      return;
    }

    // --title / --slug apply to a single document and don't make sense when
    // stamped across N different files.
    if (files.length > 1 && (opts.title || opts.slug)) {
      out.error({
        code: "conflicting_options",
        message:
          "--title and --slug apply to a single file. With multiple files, each file's first # heading becomes its title.",
      });
      return;
    }

    const docs: Array<{ file: string; content: string }> = [];
    try {
      for (const file of files) {
        const { content } = readMarkdownFile(file);
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_BYTES_PER_DOC) {
          out.error({
            code: "doc_too_large",
            message: `${file} is ${(bytes / 1024).toFixed(0)} KB; max is ${MAX_BYTES_PER_DOC / 1000} KB per document.`,
          });
          return;
        }
        docs.push({ file, content });
      }
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
      return;
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t: string) => t.trim())
      : undefined;
    const client = createApiClient(config);

    // ── Plan-limit pre-check ─────────────────────────────────────────────
    // Ask /me for the active workspace's document quota and reject
    // before doing any image upload / publish work when the job is
    // known to exceed the cap. The server enforces this for real on
    // both /publish and /publish/batch (returns 403 with a structured
    // body), but pre-checking saves wasted work and gives users a
    // one-line error instead of a partial-publish-then-fail.
    //
    // /me failures are treated as non-fatal: the publish endpoints
    // are the source of truth for the cap. Worst case the user sees
    // the server's 403 message instead of ours.
    try {
      const me = await client.me();
      const quota = me.quota?.documents;
      if (quota && quota.remaining !== null && docs.length > quota.remaining) {
        out.error({
          code: "document_limit",
          message: `Cannot publish ${docs.length} file${docs.length === 1 ? "" : "s"}: your ${quota.plan} plan has ${quota.remaining} slot${quota.remaining === 1 ? "" : "s"} left (${quota.used}/${quota.limit} used). Upgrade to Pro for unlimited documents, or unpublish existing docs first.`,
        });
        return;
      }
    } catch {
      // Non-fatal. Fall through and let the server enforce the cap.
    }

    // ── Single-file path ─────────────────────────────────────────────────
    if (docs.length === 1) {
      const { file, content } = docs[0];
      try {
        // Upload any local images referenced in the Markdown before we ship
        // the doc to the server. The rewritten content has public URLs in
        // place of local paths.
        out.spin(
          `Publishing ${brand.value(path.basename(file))} to OpenDocs...`,
        );
        let toPublish = content;
        try {
          const { markdown: rewritten, report } =
            await uploadLocalImagesAndRewrite({
              markdown: content,
              sourceFile: file,
              client,
              workspaceId: config.workspaceId,
            });
          toPublish = rewritten;
          for (const s of report.skipped) {
            out.warn(`Image skipped: ${s.original} — ${s.reason}`);
          }
        } catch (err: unknown) {
          const e = err as { message?: string; status?: number };
          // A 503 (storage_not_configured) isn't worth blocking on —
          // publish with original refs and let the user see broken images
          // rather than failing the whole doc. Keep the spinner running
          // across the warn so we flow straight into client.publish().
          if (e.status === 503) {
            out.stopSpinner();
            out.warn(
              "Image storage is not configured on the server; publishing without uploading local images.",
            );
            out.spin(
              `Publishing ${brand.value(path.basename(file))} to OpenDocs...`,
            );
          } else {
            out.stopSpinner();
            out.error({
              code: "image_upload_failed",
              message: e.message ?? "Failed to upload inline images.",
            });
            return;
          }
        }

        const result = await client.publish({
          markdown: toPublish,
          title: opts.title || undefined,
          slug: opts.slug || undefined,
          visibility: opts.visibility,
          workspaceId: config.workspaceId,
          tags,
          sourcePath: sourcePathFor(file),
          confirmPublic: opts.confirmPublic || undefined,
        });

        out.succeed("Published successfully");
        out.info(
          `${brand.label("URL:")} ${brand.url(
            `opendocs.cc/${config.workspaceSlug}/${result.slug}`,
          )}`,
        );

        // --export: use the single-doc /export endpoint (skip zip overhead).
        // Output path is derived from the source file so users who published
        // `docs/intro.md` get `docs/intro.pdf` next to it — matching the
        // multi-file behaviour.
        if (opts.export) {
          const format = opts.export as "docx" | "pdf";
          try {
            out.spin(
              `Exporting as ${brand.value(format.toUpperCase())}...`,
            );
            const { buffer } = await client.exportPost(result.postId, format);
            const outPath = path.join(
              path.dirname(file),
              `${path.basename(file, path.extname(file))}.${format}`,
            );
            fs.writeFileSync(outPath, buffer);
            out.succeed(`Exported to ${brand.value(outPath)}`);
            out.result({
              ...result,
              export: {
                format,
                path: outPath,
                bytes: buffer.length,
                success: true,
              },
            });
          } catch (err: unknown) {
            // Stop the spinner FIRST. `out.warn` and `out.info` don't own the
            // spinner — if we skip this, ora keeps animating after the catch
            // returns and pins the Node event loop open, so the process
            // appears to hang after printing the retry hint.
            out.stopSpinner();
            const e = err as { message?: string; status?: number };
            const msg =
              (e.message && e.message.trim()) ||
              (e.status ? `HTTP ${e.status}` : "unknown error");
            // Post is up — just the export failed. Give the user a one-liner
            // to retry without re-publishing.
            out.warn(`Export failed: ${msg}`);
            out.info(
              `${brand.label("Retry:")} opendocs export ${result.postId} --format ${format}`,
            );
            out.result({
              ...result,
              export: { format, success: false, error: msg },
            });
          }
          return;
        }

        out.result(result);
      } catch (err: unknown) {
        out.error(err as { status?: number; code?: string; message: string });
      }
      return;
    }

    // ── Upload inline images per doc, then batch ─────────────────────────
    // Each doc may reference its own local images; we rewrite each one so
    // the batch payload carries only public URLs.
    let imageStorageOff = false;
    for (const doc of docs) {
      if (imageStorageOff) break;
      try {
        out.spin(
          `Uploading images for ${brand.value(path.basename(doc.file))}...`,
        );
        const { markdown: rewritten, report } =
          await uploadLocalImagesAndRewrite({
            markdown: doc.content,
            sourceFile: doc.file,
            client,
            workspaceId: config.workspaceId,
          });
        doc.content = rewritten;
        out.stopSpinner();
        for (const s of report.skipped) {
          out.warn(
            `${path.basename(doc.file)}: image skipped — ${s.original}: ${s.reason}`,
          );
        }
      } catch (err: unknown) {
        out.stopSpinner();
        const e = err as { message?: string; status?: number };
        if (e.status === 503) {
          // Storage disabled — warn once and continue with original refs.
          out.warn(
            "Image storage is not configured on the server; publishing without uploading local images.",
          );
          imageStorageOff = true;
        } else {
          out.error({
            code: "image_upload_failed",
            message: `${path.basename(doc.file)}: ${e.message ?? "Failed to upload inline images."}`,
          });
          return;
        }
      }
    }

    // ── Multi-file path: auto-chunk into publish batches ─────────────────
    const batches: Array<typeof docs> = [];
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      batches.push(docs.slice(i, i + BATCH_SIZE));
    }

    type PerFileResult = {
      file: string;
      success: boolean;
      url?: string;
      slug?: string;
      postId?: string;
      title?: string;
      error?: string;
      message?: string;
    };
    const allResults: PerFileResult[] = [];
    let completed = 0;

    // Renders one server-side per-doc result as a user-facing line and
    // records it in allResults. Shared between the JSON response path and
    // the SSE stream path so they stay in lockstep.
    const handleBatchResult = (
      batch: Array<{ file: string; content: string }>,
      r:
        | {
            success: true;
            index: number;
            postId: string;
            slug: string;
            title: string;
            url: string;
          }
        | {
            success: false;
            index: number;
            error: string;
            message: string;
          },
    ) => {
      const { file } = batch[r.index];
      completed++;
      const counter = `(${completed}/${docs.length})`;
      if (r.success) {
        out.info(
          `${brand.success("✔")} ${brand.value(path.basename(file))} → ${brand.url(
            `opendocs.cc/${config.workspaceSlug}/${r.slug}`,
          )}  ${brand.muted(counter)}`,
        );
        allResults.push({
          file,
          success: true,
          url: `opendocs.cc/${config.workspaceSlug}/${r.slug}`,
          slug: r.slug,
          postId: r.postId,
          title: r.title,
        });
      } else {
        out.info(
          `${brand.error("✖")} ${brand.value(path.basename(file))} — ${r.message}  ${brand.muted(counter)}`,
        );
        allResults.push({
          file,
          success: false,
          error: r.error,
          message: r.message,
        });
      }
    };

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      out.spin(
        batches.length === 1
          ? `Publishing ${batch.length} documents...`
          : `Publishing batch ${batchIdx + 1}/${batches.length} (${batch.length} docs)...`,
      );

      try {
        const documentsPayload = batch.map(({ file, content }) => ({
          markdown: content,
          visibility: opts.visibility,
          workspaceId: config.workspaceId!,
          tags,
          sourcePath: sourcePathFor(file),
          confirmPublic: opts.confirmPublic || undefined,
        }));

        // --json mode keeps using the plain JSON endpoint so stdout stays a
        // single parseable object. Interactive mode streams per-doc events so
        // long batches show live progress rather than a silent pause.
        if (globalOpts.json) {
          const response = await client.publishBatch({
            documents: documentsPayload,
          });
          out.stopSpinner();
          for (const r of response.results) handleBatchResult(batch, r);
        } else {
          let stoppedSpinner = false;
          for await (const event of client.publishBatchStream({
            documents: documentsPayload,
          })) {
            if (event.type === "result") {
              if (!stoppedSpinner) {
                out.stopSpinner();
                stoppedSpinner = true;
              }
              handleBatchResult(batch, event.data);
            }
            // Per-batch summary events are ignored — the final rollup is
            // computed from allResults below, which already covers everything.
          }
          if (!stoppedSpinner) out.stopSpinner();
        }
      } catch (err: unknown) {
        // Network-level failure (timeout, 5xx, 429). Completed batches are
        // durable — surface clearly what did and didn't make it.
        out.stopSpinner();
        const e = err as { status?: number; code?: string; message: string };
        const remaining = docs.length - completed;
        out.warn(
          `Batch ${batchIdx + 1}/${batches.length} failed after ${completed}/${docs.length} documents: ${e.message}`,
        );
        if (remaining > 0) {
          out.warn(
            `${remaining} document${remaining === 1 ? "" : "s"} not attempted.`,
          );
        }
        const succeeded = allResults.filter((r) => r.success).length;
        out.result({
          total: docs.length,
          attempted: completed,
          succeeded,
          failed: completed - succeeded,
          notAttempted: remaining,
          results: allResults,
          aborted: true,
          abortReason: e.message,
        });
        process.exit(1);
      }
    }

    const succeeded = allResults.filter((r) => r.success).length;
    const failed = allResults.length - succeeded;
    if (failed === 0) {
      out.succeed(`${docs.length} documents published successfully.`);
    } else {
      out.warn(`${succeeded} of ${docs.length} published. ${failed} failed.`);
    }

    // ── --export phase ───────────────────────────────────────────────────
    // Runs after all publishes complete. We auto-chunk the successful
    // postIds into groups of EXPORT_BATCH_SIZE (server cap) and hit the batch
    // export endpoint for each. Each zip carries a manifest mapping
    // postId → filename, which we map back to the source file so we can
    // write `docs/intro.md` → `docs/intro.pdf` right next to the original.
    if (!opts.export) {
      out.result({
        total: docs.length,
        succeeded,
        failed,
        results: allResults,
      });
      return;
    }

    const format = opts.export as "docx" | "pdf";
    const successful = allResults.filter(
      (r): r is PerFileResult & { success: true; postId: string } =>
        r.success && !!r.postId,
    );

    type PerFileExportResult = {
      postId: string;
      file: string;
      success: boolean;
      path?: string;
      bytes?: number;
      error?: string;
      message?: string;
    };
    const exportResults: PerFileExportResult[] = [];

    if (successful.length === 0) {
      // Nothing to export. Still emit a merged JSON result so the shape is
      // stable — consumers can always check `export.total === 0` to mean
      // "publish failed, nothing was exported".
      out.result({
        total: docs.length,
        succeeded,
        failed,
        results: allResults,
        export: {
          format,
          total: 0,
          succeeded: 0,
          failed: 0,
          results: [],
        },
      });
      return;
    }

    const exportBatches: (typeof successful)[] = [];
    for (let i = 0; i < successful.length; i += EXPORT_BATCH_SIZE) {
      exportBatches.push(successful.slice(i, i + EXPORT_BATCH_SIZE));
    }

    let exportCompleted = 0;
    for (let bi = 0; bi < exportBatches.length; bi++) {
      const batch = exportBatches[bi];
      out.spin(
        exportBatches.length === 1
          ? `Exporting ${successful.length} documents as ${brand.value(format.toUpperCase())}...`
          : `Exporting batch ${bi + 1}/${exportBatches.length} as ${brand.value(format.toUpperCase())} (${batch.length} docs)...`,
      );

      try {
        const { buffer, manifest } = await client.batchExportPosts({
          postIds: batch.map((r) => r.postId),
          format,
        });
        out.stopSpinner();

        if (!manifest) {
          out.warn(
            `Batch ${bi + 1}/${exportBatches.length}: response missing manifest`,
          );
          continue;
        }

        const zip = await JSZip.loadAsync(buffer);
        const postIdToFile = new Map(batch.map((r) => [r.postId, r.file]));

        for (const r of manifest.results) {
          exportCompleted++;
          const counter = `(${exportCompleted}/${successful.length})`;
          const sourceFile = postIdToFile.get(r.postId);

          if (!r.success) {
            out.info(
              `${brand.error("✖")} ${brand.value(
                sourceFile ? path.basename(sourceFile) : r.postId,
              )} — ${r.message}  ${brand.muted(counter)}`,
            );
            exportResults.push({
              postId: r.postId,
              file: sourceFile ?? "",
              success: false,
              error: r.error,
              message: r.message,
            });
            continue;
          }

          const entry = zip.file(r.filename);
          if (!entry) {
            out.info(
              `${brand.warn("⚠")} ${r.filename} missing from archive  ${brand.muted(counter)}`,
            );
            exportResults.push({
              postId: r.postId,
              file: sourceFile ?? "",
              success: false,
              error: "missing_from_zip",
              message: `Expected ${r.filename} in archive, not found.`,
            });
            continue;
          }

          const bytes = await entry.async("nodebuffer");
          // Write next to source: docs/intro.md → docs/intro.pdf.
          // Fallback to the manifest's server-chosen filename (slug.ext) in
          // cwd if we somehow lost the source mapping.
          const safeName = safeServerFilename(r.filename);
          if (!sourceFile && !safeName) {
            out.info(
              `${brand.warn("⚠")} unsafe filename from server: ${r.filename}  ${brand.muted(counter)}`,
            );
            exportResults.push({
              postId: r.postId,
              file: "",
              success: false,
              error: "unsafe_filename",
              message: `Server returned an unsafe filename: ${r.filename}`,
            });
            continue;
          }

          const outPath = sourceFile
            ? path.join(
                path.dirname(sourceFile),
                `${path.basename(sourceFile, path.extname(sourceFile))}.${format}`,
              )
            : safeName!;
          fs.writeFileSync(outPath, bytes);
          out.info(
            `${brand.success("✔")} ${brand.value(path.basename(outPath))} ${brand.muted(
              `(${(r.bytes / 1024).toFixed(0)} KB)`,
            )} → ${brand.purple(outPath)}  ${brand.muted(counter)}`,
          );
          exportResults.push({
            postId: r.postId,
            file: sourceFile ?? "",
            success: true,
            path: outPath,
            bytes: r.bytes,
          });
        }
      } catch (err: unknown) {
        // Whole batch failed (network/timeout/5xx). Posts are still up — give
        // the user a retry hint and continue to the next batch.
        out.stopSpinner();
        const e = err as { message?: string; status?: number };
        const msg =
          (e.message && e.message.trim()) ||
          (e.status ? `HTTP ${e.status}` : "unknown error");
        out.warn(
          `Export batch ${bi + 1}/${exportBatches.length} failed: ${msg}`,
        );
        out.info(
          `${brand.label("Retry:")} opendocs export ${batch.map((r) => r.postId).join(" ")} --format ${format}`,
        );
        for (const r of batch) {
          exportCompleted++;
          exportResults.push({
            postId: r.postId,
            file: r.file,
            success: false,
            error: "export_failed",
            message: msg,
          });
        }
      }
    }

    const exportSucceeded = exportResults.filter((r) => r.success).length;
    const exportFailed = exportResults.length - exportSucceeded;
    if (exportFailed === 0) {
      out.succeed(
        `${exportSucceeded} document${exportSucceeded === 1 ? "" : "s"} exported.`,
      );
    } else {
      out.warn(
        `${exportSucceeded} of ${exportResults.length} exported. ${exportFailed} failed.`,
      );
    }

    out.result({
      total: docs.length,
      succeeded,
      failed,
      results: allResults,
      export: {
        format,
        total: exportResults.length,
        succeeded: exportSucceeded,
        failed: exportFailed,
        results: exportResults,
      },
    });
  });
