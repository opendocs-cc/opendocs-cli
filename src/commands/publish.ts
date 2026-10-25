import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { loadConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { readMarkdownFile } from "../lib/markdown.js";
import { uploadLocalImagesAndRewrite } from "../lib/images.js";
import { hashContent, openState, saveState, stateKey } from "../lib/state.js";
import { describeTarget, resolveProjectTargets } from "../lib/project-target.js";
import {
  MAX_ANONYMOUS_FILES,
  postDisplayUrl,
  postPublicUrl,
  publishAnonymously,
  resolveOrCreateProject,
  updateTrackedDocs,
  type TrackedUpdateResult,
} from "./publish-sync.js";

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
  ".opendocs",
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
  .option(
    "--project <nameOrSlug>",
    "Project name, slug or ID (defaults to the active project; created if the name is new)",
  )
  .option("--confirm-public", "Confirm public publishing")
  .option(
    "--anonymous",
    "Publish without an account: anyone with the link can read it for 24 hours (claim it later to keep it)",
  )
  .option(
    "--new",
    "Always create new documents, even for files this folder already published",
  )
  .option(
    "--force",
    "Overwrite the live version even if someone published a newer one since your last sync",
  )
  .option(
    "--export <format>",
    "After publishing, convert each doc and save next to the source file (docx | pdf)",
  )
  .action(async (files: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const loaded = loadConfig();

    if (!loaded && !opts.anonymous) {
      out.error({
        code: "not_logged_in",
        message:
          "Not signed in. Sign up free in one step: `opendocs login --email you@example.com` emails you a 6-digit code. Just need a throwaway link? `opendocs publish <file> --anonymous` makes one that lasts 24 hours.",
      });
      return;
    }

    const apiUrl =
      globalOpts.apiUrl ||
      loaded?.apiUrl ||
      process.env.OPENDOCS_API_URL ||
      "https://api.opendocs.cc";

    const { files: expandedFiles, expandedDirectoryCount } =
      expandPublishInputs(files);

    if (expandedDirectoryCount > 0 && expandedFiles.length === 0) {
      out.error({
        code: "no_markdown_files",
        message:
          "No .md files found in the provided folder. OpenDocs skips .obsidian, .trash, .git, .hg, .opendocs and node_modules directories.",
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

    const { root: stateRoot, state } = openState();

    // ── Anonymous: no account, 24-hour link ──────────────────────────────
    if (opts.anonymous) {
      if (docs.length > MAX_ANONYMOUS_FILES) {
        out.error({
          code: "too_many_files",
          message: `Anonymous publishing is limited to ${MAX_ANONYMOUS_FILES} files at a time. Sign in with \`opendocs login --email you@example.com\` to publish more.`,
        });
        return;
      }
      if (opts.visibility !== "workspace" || opts.tags || opts.project || opts.export) {
        out.warn(
          "--visibility, --tags, --project and --export don't apply to anonymous documents; ignoring them.",
        );
      }
      const results = await publishAnonymously({
        docs,
        apiUrl,
        title: opts.title,
        root: stateRoot,
        state,
        out,
      });
      saveState(stateRoot, state);
      const succeededCount = results.filter((r) => r.success).length;
      out.result({
        anonymous: true,
        total: results.length,
        succeeded: succeededCount,
        failed: results.length - succeededCount,
        results,
        message:
          "Anonymous links expire in 24 hours. To keep them, sign up free: run `opendocs login --email <email>` in this folder and they move into your workspace.",
      });
      if (succeededCount < results.length) process.exit(1);
      return;
    }

    const config = loaded!;
    config.apiUrl = apiUrl;

    if (!config.workspaceId) {
      out.error({
        code: "no_workspace",
        message:
          'No workspace found. Run "opendocs login" to refresh your config.',
      });
      return;
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t: string) => t.trim())
      : undefined;
    const client = createApiClient(config);
    let activeProject: { id: string; slug: string; name: string } | null = config.projectId
      ? {
          id: config.projectId,
          slug: config.projectSlug ?? "default",
          name: config.projectName ?? "Default",
        }
      : null;
    let flagProject: { id: string; slug: string; name: string } | null = null;
    if (opts.project) {
      try {
        activeProject = flagProject = await resolveOrCreateProject(
          client,
          config.workspaceId,
          opts.project,
          out,
        );
      } catch (err: unknown) {
        out.error(err as { status?: number; code?: string; message: string });
        return;
      }
    }

    // ── Files this folder already published: update in place ─────────────
    // `.opendocs/state.json` maps each file to its post, so re-running
    // publish never creates "notes-2". --new opts out.
    const localHashes = new Map(docs.map((d) => [d.file, hashContent(d.content)]));
    const trackedDocs = opts.new
      ? []
      : docs.filter((d) => Boolean(state.docs[stateKey(stateRoot, d.file)]));
    let updateResults: TrackedUpdateResult[] = [];
    if (trackedDocs.length > 0) {
      const explicitVisibility =
        cmd.getOptionValueSource("visibility") === "cli" ? opts.visibility : undefined;
      try {
        updateResults = await updateTrackedDocs({
          docs: trackedDocs,
          client,
          config,
          root: stateRoot,
          state,
          out,
          force: Boolean(opts.force),
          overrides: {
            title: opts.title,
            visibility: explicitVisibility,
            tags,
            projectId: opts.project ? activeProject?.id : undefined,
            confirmPublic: opts.confirmPublic,
          },
        });
      } finally {
        saveState(stateRoot, state);
      }
    }
    const trackedFiles = new Set(trackedDocs.map((d) => d.file));
    docs.splice(0, docs.length, ...docs.filter((d) => !trackedFiles.has(d.file)));

    // Records a freshly published doc so the next publish updates it.
    const track = (
      file: string,
      result: { postId: string; slug: string; url: string; projectId?: string; projectSlug?: string },
    ) => {
      state.docs[stateKey(stateRoot, file)] = {
        postId: result.postId,
        slug: result.slug,
        url: result.url,
        workspaceId: config.workspaceId!,
        projectId: result.projectId ?? activeProject?.id,
        projectSlug: result.projectSlug ?? activeProject?.slug,
        versionNumber: 1,
        localHash: localHashes.get(file) ?? "",
        syncedAt: new Date().toISOString(),
      };
      state.workspaceId ??= config.workspaceId;
      state.workspaceSlug ??= config.workspaceSlug;
    };
    // Every exit below goes through emit() so state is saved and tracked
    // updates are reported alongside new publishes.
    const emit = (data: Record<string, unknown>) => {
      saveState(stateRoot, state);
      out.result(updateResults.length > 0 ? { ...data, updated: updateResults } : data);
    };

    // Which project each new file goes to (flag > clone path > folder link
    // > active project), reported so agents and users see where it landed.
    const targets = await resolveProjectTargets({
      client,
      config,
      root: stateRoot,
      state,
      files: docs.map((d) => d.file),
      flagProject,
    });
    const projectIdFor = (file: string) => targets.get(file)?.id;
    const reportedTargets = new Set<string>();
    for (const target of targets.values()) {
      const label = describeTarget(target);
      if (target.source !== "active" && !reportedTargets.has(label) && docs.length > 0) {
        reportedTargets.add(label);
        out.info(`${brand.label("Project:")} ${brand.value(label)}`);
      }
    }

    // ── --export ─────────────────────────────────────────────────────────
    // Exports what this run published or updated (a file that hadn't changed
    // is exported too; the server serves it from its cache), so re-running
    // `publish <folder> --export pdf` after a round of edits gives a fresh
    // PDF for every file. Batches of EXPORT_BATCH_SIZE (the server cap);
    // each zip's manifest maps postId → filename, which we map back to the
    // source file so `docs/intro.md` → `docs/intro.pdf` lands next to it.
    const exportFormat = opts.export as "docx" | "pdf" | undefined;
    const updatedExportTargets = updateResults
      .filter((r) => r.success && (r.action === "updated" || r.action === "unchanged"))
      .map((r) => ({ postId: r.postId, file: r.file }));
    type PerFileExportResult = {
      postId: string;
      file: string;
      success: boolean;
      path?: string;
      bytes?: number;
      error?: string;
      message?: string;
    };
    const exportDocs = async (
      format: "docx" | "pdf",
      toExport: Array<{ postId: string; file: string }>,
    ) => {
      if (toExport.length === 0) return { format, total: 0, succeeded: 0, failed: 0, results: [] };
      const exportResults: PerFileExportResult[] = [];
      const exportBatches: (typeof toExport)[] = [];
      for (let i = 0; i < toExport.length; i += EXPORT_BATCH_SIZE) {
        exportBatches.push(toExport.slice(i, i + EXPORT_BATCH_SIZE));
      }

      let exportCompleted = 0;
      for (let bi = 0; bi < exportBatches.length; bi++) {
        const batch = exportBatches[bi];
        out.spin(
          exportBatches.length === 1
            ? `Exporting ${toExport.length} document${toExport.length === 1 ? "" : "s"} as ${brand.value(format.toUpperCase())}...`
            : `Exporting batch ${bi + 1}/${exportBatches.length} as ${brand.value(format.toUpperCase())} (${batch.length} docs)...`,
        );

        try {
          const { buffer, manifest } = await client.batchExportPosts({
            postIds: batch.map((r) => r.postId),
            format,
            workspaceId: config.workspaceId,
            ...(activeProject ? { projectId: activeProject.id } : {}),
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
            const counter = `(${exportCompleted}/${toExport.length})`;
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

      return {
        format,
        total: exportResults.length,
        succeeded: exportSucceeded,
        failed: exportFailed,
        results: exportResults,
      };
    };

    if (docs.length === 0) {
      const ok = updateResults.filter((r) => r.success).length;
      emit({
        total: updateResults.length,
        succeeded: ok,
        failed: updateResults.length - ok,
        results: [],
        ...(exportFormat && updatedExportTargets.length > 0
          ? { export: await exportDocs(exportFormat, updatedExportTargets) }
          : {}),
      });
      if (ok < updateResults.length) process.exit(1);
      return;
    }

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
    // (With updated files to export as well, the multi-file path below
    // exports them all together.)
    if (docs.length === 1 && !(exportFormat && updatedExportTargets.length > 0)) {
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
          ...(projectIdFor(file) ? { projectId: projectIdFor(file) } : {}),
          tags,
          sourcePath: sourcePathFor(file),
          confirmPublic: opts.confirmPublic || undefined,
        });

        track(file, result);
        const published = { ...result, projectSource: targets.get(file)?.source ?? "active" };
        out.succeed("Published successfully");
        out.info(
          `${brand.label("URL:")} ${brand.url(
            postDisplayUrl(result),
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
            const { buffer } = await client.exportPost(result.postId, format, undefined, {
              workspaceId: config.workspaceId,
              ...(activeProject ? { projectId: activeProject.id } : {}),
            });
            const outPath = path.join(
              path.dirname(file),
              `${path.basename(file, path.extname(file))}.${format}`,
            );
            fs.writeFileSync(outPath, buffer);
            out.succeed(`Exported to ${brand.value(outPath)}`);
            emit({
              ...published,
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
            emit({
              ...published,
              export: { format, success: false, error: msg },
            });
          }
          return;
        }

        emit(published);
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
      publicUrl?: string;
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
            publicUrl?: string;
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
        track(file, r);
        out.info(
          `${brand.success("✔")} ${brand.value(path.basename(file))} → ${brand.url(
            postDisplayUrl(r),
          )}  ${brand.muted(counter)}`,
        );
        allResults.push({
          file,
          success: true,
          url: postDisplayUrl(r),
          publicUrl: postPublicUrl(r),
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
          ...(projectIdFor(file) ? { projectId: projectIdFor(file) } : {}),
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
        emit({
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
      out.succeed(`${docs.length} document${docs.length === 1 ? "" : "s"} published successfully.`);
    } else {
      out.warn(`${succeeded} of ${docs.length} published. ${failed} failed.`);
    }

    // ── --export phase: everything published or updated above ────────────
    if (!exportFormat) {
      emit({
        total: docs.length,
        succeeded,
        failed,
        results: allResults,
      });
      return;
    }

    const exportTargets = [
      ...updatedExportTargets,
      ...allResults
        .filter((r): r is PerFileResult & { postId: string } => r.success && !!r.postId)
        .map((r) => ({ postId: r.postId, file: r.file })),
    ];
    emit({
      total: docs.length,
      succeeded,
      failed,
      results: allResults,
      export: await exportDocs(exportFormat, exportTargets),
    });
  });
