import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient, type StorageFormat } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";
import { integrationError, printChecksum } from "../lib/integrations.js";

/**
 * `opendocs save <doc> --folder "Board Minutes"` — render a document and
 * put it in one of the Drive folders the workspace named in the dashboard.
 * Only when the user asks for it; `opendocs integrations` lists the names.
 */

const FORMATS: StorageFormat[] = ["pdf", "docx", "md"];

/** `3` or `v3` → 3. Null when it isn't a positive whole number. */
export function parseVersionNumber(value: unknown): number | null {
  const n = Number(String(value).trim().replace(/^v/i, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const saveCommand = new Command("save")
  .description(
    'Save a document to a named Google Drive folder: `opendocs save minutes.md --folder "Board Minutes"`. See `opendocs integrations` for folder names.',
  )
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .requiredOption("--folder <name>", "Drive folder name the workspace set up (see `opendocs integrations`)")
  .option("--format <format>", "pdf, docx or md", "pdf")
  .option("--version <n>", "Save an earlier version (see `opendocs history`)")
  .option("--filename <name>", "File name in Drive; the format's extension is added (default: the document title)")
  .action(async (ref: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
    if (!config.workspaceId) {
      out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
      return;
    }

    const format = String(opts.format).toLowerCase() as StorageFormat;
    if (!FORMATS.includes(format)) {
      out.error({ code: "invalid_format", message: `Invalid --format: ${opts.format}. Use pdf, docx or md.` });
      return;
    }
    let versionNumber: number | undefined;
    if (opts.version !== undefined) {
      const n = parseVersionNumber(opts.version);
      if (n === null) {
        out.error({ code: "invalid_version", message: `Invalid --version: ${opts.version}. Use a version number like 3 (see \`opendocs history\`).` });
        return;
      }
      versionNumber = n;
    }
    const folder = String(opts.folder).trim();
    if (!folder) {
      out.error({ code: "missing_folder", message: "Pass --folder with a folder name from `opendocs integrations`." });
      return;
    }

    try {
      const postId = resolveDocRef(ref);
      out.spin(`Saving ${brand.muted(ref)} to ${brand.value(folder)} as ${format.toUpperCase()}...`);
      const result = await createApiClient(config).saveToStorage(postId, {
        workspaceId: config.workspaceId,
        destination: folder,
        format,
        ...(versionNumber !== undefined ? { versionNumber } : {}),
        ...(opts.filename ? { filename: String(opts.filename) } : {}),
      });
      out.succeed(`Saved ${brand.value(result.file.name)} to ${brand.value(result.destination.name)}`);
      out.info(
        brand.muted(
          `${result.document.title}, v${result.document.versionNumber}, ${result.file.format.toUpperCase()}, ${formatBytes(result.file.bytes)}`,
        ),
      );
      out.info(brand.url(result.file.url));
      printChecksum(out, result.file);
      out.result(result);
    } catch (err) {
      out.error(integrationError(err));
    }
  });
