import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { findStateRoot, loadState } from "../lib/state.js";

function folderLink(workspaceId: string | undefined) {
  const root = findStateRoot();
  if (!root) return null;
  const state = loadState(root);
  return state.project && (!state.workspaceId || state.workspaceId === workspaceId) ? state.project : null;
}

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

      // Prefer the locally-active workspace from config. `opendocs workspace
      // use` updates config but not the server's /me response (which returns
      // the user's server-side primary workspace), so trusting /me here would
      // show a stale workspace after a switch.
      const username =
        config.username ?? data.onboarding?.username ?? "unknown";
      const workspace =
        config.workspaceName ?? data.onboarding?.workspace?.name ?? "none";
      const activeSlug =
        config.workspaceSlug ?? data.onboarding?.workspace?.slug;
      const activeProject =
        config.projectId && config.projectSlug && config.projectName
          ? {
              id: config.projectId,
              name: config.projectName,
              slug: config.projectSlug,
            }
          : data.onboarding?.workspace?.defaultProject;

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
      out.info(
        `${brand.label("Project:")}    ${
          activeProject
            ? `${brand.value(activeProject.name)} ${brand.muted(`(${activeProject.slug})`)}`
            : brand.muted("none")
        }`,
      );
      out.info(`${brand.label("API URL:")}    ${brand.muted(config.apiUrl)}`);

      // Merge the active workspace (from local config) into the JSON output
      // so `--json` consumers see the same workspace the display shows and
      // the same one the next `publish` will use. The /me response's
      // `onboarding.workspace` is the server-side primary, not the CLI's
      // active choice, so we override it here.
      const active =
        config.workspaceId && config.workspaceSlug && config.workspaceName
          ? {
              id: config.workspaceId,
              name: config.workspaceName,
              slug: config.workspaceSlug,
            }
          : data.onboarding?.workspace;
      out.result({
        ...data,
        onboarding: {
          ...data.onboarding,
          workspace: active,
        },
        project: activeProject ?? null,
        // Folder → project link for the current directory, if any, and the
        // user's organize preference (see "Keeping documents organized").
        folderProject: folderLink(config.workspaceId),
        organize: config.organize ?? "ask",
      });
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
