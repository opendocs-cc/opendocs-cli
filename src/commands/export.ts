import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand, type Output } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";
import { listAllPosts, resolvePullProject } from "./pull.js";

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

type Client = ReturnType<typeof createApiClient>;
type WriteResult = {
  postId: string;
  filename?: string;
  path?: string;
  bytes?: number;
  success: boolean;
  error?: string;
  message?: string;
};

// One batch-export round trip: request a zip for up to MAX_BATCH_SIZE posts
// and write each file in it to `outDir`, guarding against unsafe names.
async function exportBatchToDir({
  client,
  postIds,
  format,
  landscape,
  accentColor,
  workspaceId,
  projectId,
  outDir,
  out,
}: {
  client: Client;
  postIds: string[];
  format: "docx" | "pdf";
  landscape?: boolean;
  accentColor?: string;
  workspaceId?: string;
  projectId?: string;
  outDir: string;
  out: Output;
}): Promise<WriteResult[]> {
  const { buffer, manifest } = await client.batchExportPosts({
    postIds,
    format,
    landscape: landscape || undefined,
    accent_color: accentColor,
    workspaceId,
    projectId,
  });
  out.stopSpinner();
  if (!manifest) {
    throw Object.assign(new Error("Server response is missing the batch manifest."), {
      code: "missing_manifest",
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const zip = await JSZip.loadAsync(buffer);
  const writeResults: WriteResult[] = [];

  for (const r of manifest.results) {
    if (!r.success) {
      out.info(`${brand.error("✖")} ${brand.value(r.postId)} — ${r.message}`);
      writeResults.push({ postId: r.postId, success: false, error: r.error, message: r.message });
      continue;
    }
    const safeName = safeServerFilename(r.filename);
    const entry = safeName ? zip.file(r.filename) : null;
    const outPath = safeName ? safeOutputPath(outDir, safeName) : null;
    if (!safeName || !outPath) {
      out.info(`${brand.warn("⚠")} unsafe filename from server: ${brand.value(r.filename)}`);
      writeResults.push({
        postId: r.postId,
        success: false,
        error: "unsafe_filename",
        message: `Server returned an unsafe filename: ${r.filename}`,
      });
      continue;
    }
    if (!entry) {
      // Defensive: manifest says success but zip is missing the file.
      out.info(`${brand.warn("⚠")} ${brand.value(r.filename)} missing from archive`);
      writeResults.push({
        postId: r.postId,
        success: false,
        error: "missing_from_zip",
        message: `Expected ${r.filename} inside archive, not found.`,
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
    writeResults.push({ postId: r.postId, filename: safeName, path: outPath, bytes: r.bytes, success: true });
  }
  return writeResults;
}

function reportExport(out: Output, format: string, writeResults: WriteResult[]) {
  const succeeded = writeResults.filter((r) => r.success).length;
  const total = writeResults.length;
  const failed = total - succeeded;
  if (failed === 0) {
    out.succeed(`${total} document${total === 1 ? "" : "s"} exported.`);
  } else {
    out.warn(`${succeeded} of ${total} exported. ${failed} failed.`);
  }
  out.result({ format, total, succeeded, failed, results: writeResults });
}

/**
 * Where a single export goes. `-o` is normally the file path, but an
 * existing directory (or a path ending in a slash, created if needed)
 * gets the server's filename inside it, so `-o .` and `-o exports/` work.
 */
function singleExportPath(output: string | undefined, fileName: string): string {
  if (!output) return fileName;
  const isDir =
    output.endsWith("/") ||
    output.endsWith(path.sep) ||
    (fs.existsSync(output) && fs.statSync(output).isDirectory());
  if (!isDir) return output;
  fs.mkdirSync(output, { recursive: true });
  return path.join(output, fileName);
}

export const exportCommand = new Command("export")
  .description("Export one or more posts as .docx or .pdf")
  .argument(
    "[idsOrSlugs...]",
    "Post ID(s), slug(s) or published .md files. Pass multiple for a batch export. See `opendocs list`.",
  )
  .option("--project <slugOrId>", "Export every document in a project (into -o, default ./<project>-<format>)")
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
  .action(async (rawPostIds: string[], opts, cmd) => {
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

    const postIds = rawPostIds.map(resolveDocRef);

    // ── Whole project: list it, then export in batches of 10 ─────────────
    if (opts.project) {
      if (postIds.length > 0 || opts.stdout) {
        out.error({
          code: "conflicting_options",
          message: "--project exports a whole project; don't combine it with document IDs or --stdout.",
        });
        return;
      }
      try {
        const client = createApiClient(config);
        out.spin("Listing project documents...");
        const project = await resolvePullProject(client, config, opts.project);
        const posts = await listAllPosts(client, {
          workspaceId: config.workspaceId!,
          projectId: project.id,
        });
        const outDir = path.resolve(opts.output || `${project.slug}-${format}`);
        const results: WriteResult[] = [];
        for (let i = 0; i < posts.length; i += MAX_BATCH_SIZE) {
          const chunk = posts.slice(i, i + MAX_BATCH_SIZE);
          out.spin(
            `Exporting ${i + 1}–${i + chunk.length} of ${posts.length} as ${brand.value(format.toUpperCase())}...`,
          );
          results.push(
            ...(await exportBatchToDir({
              client,
              postIds: chunk.map((p) => p.id),
              format: format as "docx" | "pdf",
              landscape: opts.landscape,
              accentColor: opts.accentColor,
              workspaceId: config.workspaceId,
              projectId: project.id,
              outDir,
              out,
            })),
          );
        }
        out.stopSpinner();
        if (posts.length === 0) out.info(`Project ${project.name} has no documents.`);
        reportExport(out, format, results);
      } catch (err: unknown) {
        out.error(err as { status?: number; code?: string; message: string });
      }
      return;
    }

    if (postIds.length === 0) {
      out.error({
        code: "missing_argument",
        message: "Pass one or more document IDs/slugs, or --project <project> to export a whole project.",
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
          { workspaceId: config.workspaceId, projectId: config.projectId },
        );

        if (opts.stdout) {
          process.stdout.write(buffer);
          out.result({ postId, format, filename, bytes: buffer.length });
          return;
        }

        const safeName =
          safeServerFilename(filename) ?? `document.${format}`;
        const outPath = singleExportPath(opts.output, safeName);
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
      // `-o` is a DIRECTORY in multi-postId mode. Default is cwd.
      const results = await exportBatchToDir({
        client,
        postIds,
        format: format as "docx" | "pdf",
        landscape: opts.landscape,
        accentColor: opts.accentColor,
        workspaceId: config.workspaceId,
        projectId: config.projectId,
        outDir: path.resolve(opts.output || "."),
        out,
      });
      reportExport(out, format, results);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
