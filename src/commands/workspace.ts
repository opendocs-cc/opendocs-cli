import { Command } from "commander";
import { getConfigOrExit, saveConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

// Parent command — has no action of its own; behaves as a namespace for
// `opendocs workspace list` and `opendocs workspace use <slug>`. Commander
// renders the subcommand list when invoked without a subcommand.
export const workspaceCommand = new Command("workspace")
  .description("List and switch between workspaces you belong to");

// ── opendocs workspace list ─────────────────────────────────────────────
workspaceCommand
  .command("list")
  .alias("ls")
  .description("List every workspace you belong to")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Fetching workspaces...");
      const client = createApiClient(config);
      const { workspaces } = await client.listWorkspaces();

      const activeSlug = config.workspaceSlug ?? null;

      out.succeed(
        `${brand.purpleBold(String(workspaces.length))} workspace${workspaces.length === 1 ? "" : "s"}`,
      );

      if (workspaces.length === 0) {
        out.info(
          `You are not a member of any workspaces. Complete onboarding in the dashboard first.`,
        );
      } else {
        const header = `  ${pad("Active", 8)} ${pad("Name", 30)} ${pad("Slug", 24)} ${pad("Role", 10)}`;
        out.info(brand.label(header));
        out.info(brand.label("  " + "\u2500".repeat(74)));

        for (const ws of workspaces) {
          const isActive = ws.slug === activeSlug;
          const activeCell = isActive ? brand.success(pad("✔", 8)) : pad("", 8);
          const name = isActive
            ? brand.purpleBold(pad(ws.name, 30))
            : brand.value(pad(ws.name, 30));
          const slug = brand.muted(pad(ws.slug, 24));
          const role = brand.muted(pad(ws.role, 10));
          out.info(`  ${activeCell} ${name} ${slug} ${role}`);
        }

        if (workspaces.length > 1 && activeSlug) {
          out.info("");
          out.info(
            brand.muted(
              `  Switch with ${brand.purple(`opendocs workspace use <slug>`)}`,
            ),
          );
        }
      }

      out.result({ workspaces, activeSlug });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

// ── opendocs workspace use <slug> ───────────────────────────────────────
workspaceCommand
  .command("use <slug>")
  .alias("switch")
  .description("Switch the CLI's active workspace")
  .action(async (slug: string, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin(`Looking up ${brand.value(slug)}...`);
      const client = createApiClient(config);
      const { workspaces } = await client.listWorkspaces();

      const match = workspaces.find((w) => w.slug === slug);
      if (!match) {
        out.stopSpinner();
        out.error({
          code: "not_a_member",
          message: `You are not a member of a workspace with slug "${slug}". Run "opendocs workspace list" to see available workspaces.`,
        });
        return;
      }

      // Preserve auth-related fields; swap in the new workspace identifiers.
      // saveConfig expects the full shape, so we splat the existing config
      // rather than partial-write.
      saveConfig({
        ...config,
        workspaceId: match.id,
        workspaceName: match.name,
        workspaceSlug: match.slug,
      });

      out.succeed(
        `Switched to ${brand.purpleBold(match.name)} ${brand.muted(`(${match.slug})`)}`,
      );
      out.result({
        success: true,
        workspaceId: match.id,
        workspaceName: match.name,
        workspaceSlug: match.slug,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

// Shared with list.ts — kept local rather than exported so each command
// owns its own column widths. Truncates with an ellipsis when over-length.
function pad(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…";
  return str.padEnd(len);
}
