import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current authentication status")
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    try {
      out.spin("Verifying credentials with OpenDocs...");
      const client = createApiClient(config);
      const data = await client.me();

      // Best-effort multi-workspace lookup — used to render
      // "(active, 1 of N)" next to the workspace. Failures here shouldn't
      // break `whoami`, which is primarily an auth-check command.
      let workspaces: Array<{ id: string; slug: string; name: string }> = [];
      try {
        const res = await client.listWorkspaces();
        workspaces = res.workspaces;
      } catch {
        // Fall through with an empty list; hint just won't render.
      }

      const username = data.onboarding?.username ?? "unknown";
      const workspace = data.onboarding?.workspace?.name ?? "none";
      const activeSlug = data.onboarding?.workspace?.slug;

      // Build the suffix: "(active, 1 of 3) — opendocs workspace list"
      // Only shown when the caller has >1 workspace.
      let suffix = "";
      if (workspaces.length > 1 && activeSlug) {
        const idx = workspaces.findIndex((w) => w.slug === activeSlug);
        const pos = idx >= 0 ? idx + 1 : 1;
        suffix =
          "  " +
          brand.muted(
            `(active, ${pos} of ${workspaces.length}) — ${brand.purple("opendocs workspace list")}`,
          );
      }

      out.succeed("Authenticated");
      out.info(`${brand.label("Username:")}   ${brand.purpleBold(username)}`);
      out.info(`${brand.label("Workspace:")}  ${brand.value(workspace)}${suffix}`);
      out.info(`${brand.label("API URL:")}    ${brand.muted(config.apiUrl)}`);
      out.result(data);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
