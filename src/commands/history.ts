import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { resolveDocRef } from "../lib/doc-ref.js";

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const historyCommand = new Command("history")
  .description("List every published version of a document")
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .action(async (ref: string, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    try {
      out.spin("Loading history...");
      const client = createApiClient(config);
      const data = await client.listVersions(resolveDocRef(ref), { workspaceId: config.workspaceId });
      out.stopSpinner();
      for (const v of data.versions) {
        const marker = v.isCurrent ? brand.success("● current") : brand.muted("○");
        const who = [v.createdBy ? `@${v.createdBy}` : null, v.client ? `via ${v.client}` : null]
          .filter(Boolean)
          .join(" ");
        const restored = v.restoredFromVersion ? brand.muted(` (restored from v${v.restoredFromVersion})`) : "";
        out.info(
          `${marker} ${brand.value(`v${v.versionNumber}`)}  ${ago(v.createdAt).padEnd(9)} ${brand.muted(who)}${restored}`,
        );
      }
      out.info(
        brand.muted(
          `Roll back: ${brand.purple(`opendocs rollback ${ref} <version>`)} · Read an old version: ${brand.purple(`opendocs pull ${ref} --version <n> --stdout`)}`,
        ),
      );
      out.result(data);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });

export const rollbackCommand = new Command("rollback")
  .alias("restore")
  .description("Restore an earlier version (published as a new version, so it can be undone)")
  .argument("<doc>", "Post ID, slug, or a local .md file this folder published")
  .argument("<version>", "Version number to restore — see `opendocs history`")
  .action(async (ref: string, version: string, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;

    const versionNumber = Number(version.replace(/^v/i, ""));
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      out.error({ code: "invalid_version", message: `"${version}" is not a version number. Run \`opendocs history ${ref}\`.` });
      return;
    }

    try {
      out.spin(`Restoring v${versionNumber}...`);
      const client = createApiClient(config);
      const result = await client.restoreVersion(resolveDocRef(ref), versionNumber, {
        workspaceId: config.workspaceId,
      });
      out.succeed(
        `Restored v${result.restoredFromVersion} as ${brand.value(`v${result.versionNumber}`)} — "${result.title}"`,
      );
      out.info(
        brand.muted(
          "Your local file is unchanged. Run `opendocs pull` to fetch the restored content before editing.",
        ),
      );
      out.result(result);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
