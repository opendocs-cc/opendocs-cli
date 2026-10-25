import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";
import { claimTrackedAnonymousDocs } from "../lib/claim.js";
import { postDisplayUrl } from "./publish-sync.js";

export const claimCommand = new Command("claim")
  .description(
    "Keep anonymous documents: claim them into the active workspace. With no argument, claims everything this folder published anonymously.",
  )
  .argument("[claimUrlOrToken]", "A claim URL (opendocs.cc/claim/...) or claim token")
  .option("--visibility <visibility>", "private | workspace", "workspace")
  .action(async (ref: string | undefined, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit(out);
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
    if (!config.workspaceId) {
      out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
      return;
    }

    try {
      const client = createApiClient(config);
      if (!ref) {
        const results = await claimTrackedAnonymousDocs(client, config, out);
        if (results.length === 0) out.info("No anonymous documents recorded in this folder.");
        out.result({ results });
        return;
      }

      const token = ref.includes("/claim/") ? ref.split("/claim/")[1].split(/[?#]/)[0] : ref.trim();
      out.spin("Claiming...");
      const post = await client.claimAnonymous({
        claimToken: token,
        workspaceId: config.workspaceId,
        ...(config.projectId ? { projectId: config.projectId } : {}),
        visibility: opts.visibility,
      });
      out.succeed(`Claimed "${post.title}" → ${brand.url(postDisplayUrl(post))}`);
      out.result(post);
    } catch (err: unknown) {
      out.error(err as { status?: number; code?: string; message: string });
    }
  });
