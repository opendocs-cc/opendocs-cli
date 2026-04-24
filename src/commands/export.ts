import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

// Mirrors MAX_BATCH_SIZE in packages/shared/src/posts/validation.ts.
// Kept as a local constant so the CLI can fail pre-flight before a network
// round-trip when a user passes too many postIds.
const MAX_BATCH_SIZE = 10;

function safeServerFilename(filename: string): string | null {
  if (!filename || filename.includes("\0")) return null;
  if (path.isAbsolute(filename)) return null;
  if (filename.includes("/") || filename.includes("\\")) return null;
  const base = path.basename(filename);
  if (base !== filename || base === "." || base === "..") return null;
  return base;
}

function safeOutputPath(dir: string, filename: string): string | null {
  const resolvedDir = path.resolve(dir);
  const outPath = path.resolve(resolvedDir, filename);
  const rel = path.relative(resolvedDir, outPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return outPath;
}

export const exportCommand = new Command("export")
  .description("Export one or more posts as .docx or .pdf")
  .argument(
    "<idsOrSlugs...>",
    "Post ID(s) or slug(s). Pass multiple for a batch export (delivered as a zip). See `opendocs list`.",
  )
  .option("-f, --format <format>", "Output format (docx or pdf)", "docx")
  .option(
    "-o, --output <path>",
    "Output file (single doc) or directory (multiple docs)",
  )
  .option("--stdout", "Write the binary file to stdout (single doc only)")
  .option("--landscape", "Render in landscape A4")
  .option(
    "--accent-color <hex>",
    "Brand accent hex color (e.g. #B91C1C) — derives the full palette",
  )
  .action(async (postIds: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    const format = opts.format as string;
    if (format !== "docx" && format !== "pdf") {
      out.error({
        code: "invalid_format",
        message: `Invalid --format: ${format}. Use "docx" or "pdf".`,
      });
      return;
    }

    // --stdout is single-doc only; a zip containing N binaries isn't
    // something you can meaningfully pipe straight into a downstream tool.
    if (opts.stdout && postIds.length > 1) {
      out.error({
        code: "conflicting_options",
        message:
          "--stdout is only supported when exporting a single document.",
      });
      return;
    }

    if (postIds.length > MAX_BATCH_SIZE) {
      out.error({
        code: "too_many_posts",
        message: `Got ${postIds.length} documents; max is ${MAX_BATCH_SIZE} per export. Split into smaller groups.`,
      });
      return;
    }

    const client = createApiClient(config);

    // ── Single-postId path: unchanged behaviour ──────────────────────────
    if (postIds.length === 1) {
      const postId = postIds[0];
      try {
        if (!opts.stdout) {
          out.spin(
            `Exporting ${brand.muted(postId)} as ${brand.value(format.toUpperCase())}...`,
          );
        }

        const { buffer, filename } = await client.exportPost(
          postId,
          format as "docx" | "pdf",
          {
            landscape: opts.landscape || undefined,
            accent_color: opts.accentColor,
          },
          { workspaceId: config.workspaceId },
        );

        if (opts.stdout) {
          process.stdout.write(buffer);
          out.result({ postId, format, filename, bytes: buffer.length });
          return;
        }

        const safeName =
          safeServerFilename(filename) ?? `document.${format}`;
        const outPath = opts.output || safeName;
        fs.writeFileSync(outPath, buffer);

        out.succeed(`Exported ${brand.value(safeName)}`);
        out.info(`${brand.label("Saved to:")} ${brand.purple(outPath)}`);
        out.result({ postId, format, filename: outPath, bytes: buffer.length });
      } catch (err: unknown) {
        const error = err as { status?: number; code?: string; message: string };
        out.error(error);
      }
      return;
    }

    // ── Multi-postId path: batch endpoint → zip extraction ───────────────
    try {
      out.spin(
        `Exporting ${postIds.length} posts as ${brand.value(format.toUpperCase())}...`,
      );

      const { buffer, manifest } = await client.batchExportPosts({
        postIds,
        format: format as "docx" | "pdf",
        landscape: opts.landscape || undefined,
        accent_color: opts.accentColor,
        workspaceId: config.workspaceId,
      });

      out.stopSpinner();

      if (!manifest) {
        out.error({
          code: "missing_manifest",
          message: "Server response is missing the batch manifest.",
        });
        return;
      }

      // `-o` is a DIRECTORY in multi-postId mode. Default is cwd.
      const outDir = path.resolve(opts.output || ".");
      fs.mkdirSync(outDir, { recursive: true });

      const zip = await JSZip.loadAsync(buffer);
      const writeResults: Array<{
        postId: string;
        filename?: string;
        path?: string;
        bytes?: number;
        success: boolean;
        error?: string;
        message?: string;
      }> = [];

      for (const r of manifest.results) {
        if (!r.success) {
          out.info(
            `${brand.error("✖")} ${brand.value(r.postId)} — ${r.message}`,
          );
          writeResults.push({
            postId: r.postId,
            success: false,
            error: r.error,
            message: r.message,
          });
          continue;
        }
        const safeName = safeServerFilename(r.filename);
        if (!safeName) {
          out.info(
            `${brand.warn("⚠")} unsafe filename from server: ${brand.value(r.filename)}`,
          );
          writeResults.push({
            postId: r.postId,
            success: false,
            error: "unsafe_filename",
            message: `Server returned an unsafe filename: ${r.filename}`,
          });
          continue;
        }

        const entry = zip.file(r.filename);
        if (!entry) {
          // Defensive: manifest says success but zip is missing the file.
          // Shouldn't happen, but surface it clearly instead of a silent skip.
          out.info(
            `${brand.warn("⚠")} ${brand.value(r.filename)} missing from archive`,
          );
          writeResults.push({
            postId: r.postId,
            success: false,
            error: "missing_from_zip",
            message: `Expected ${r.filename} inside archive, not found.`,
          });
          continue;
        }
        const outPath = safeOutputPath(outDir, safeName);
        if (!outPath) {
          out.info(
            `${brand.warn("⚠")} unsafe output path for ${brand.value(safeName)}`,
          );
          writeResults.push({
            postId: r.postId,
            success: false,
            error: "unsafe_filename",
            message: `Server returned an unsafe filename: ${r.filename}`,
          });
          continue;
        }

        const bytes = await entry.async("nodebuffer");
        fs.writeFileSync(outPath, bytes);
        out.info(
          `${brand.success("✔")} ${brand.value(safeName)} ${brand.muted(
            `(${(r.bytes / 1024).toFixed(0)} KB)`,
          )} → ${brand.purple(outPath)}`,
        );
        writeResults.push({
          postId: r.postId,
          filename: safeName,
          path: outPath,
          bytes: r.bytes,
          success: true,
        });
      }

      const { succeeded, failed, total } = manifest.summary;
      if (failed === 0) {
        out.succeed(`${total} document${total === 1 ? "" : "s"} exported.`);
      } else {
        out.warn(`${succeeded} of ${total} exported. ${failed} failed.`);
      }
      out.result({
        format,
        total,
        succeeded,
        failed,
        results: writeResults,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
