import { Argument, Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

// Three user-facing levels. The server enum also includes
// `restricted_email`, but that requires a companion email-allowlist
// surface that doesn't fit a one-shot CLI call — we intentionally hide
// it here rather than let users set it and see confusing behavior.
const VISIBILITY_LEVELS = ["private", "workspace", "public"] as const;
type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

export const visibilityCommand = new Command("visibility")
  .description(
    "Change a published post's visibility without re-uploading its Markdown",
  )
  .argument("<idOrSlug>", "Post ID (UUID) or slug — see `opendocs list`")
  .addArgument(
    new Argument("<level>", "New visibility level").choices(
      VISIBILITY_LEVELS as unknown as string[],
    ),
  )
  .option(
    "--confirm-public",
    "Required when setting <level> to `public` — acknowledges that the post will be visible to anyone with the link",
  )
  .action(async (postId: string, level: VisibilityLevel, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    // Pre-flight: going `public` without --confirm-public is a no-op
    // before we even hit the network. The server enforces the same rule,
    // but surfacing it locally saves a round-trip and produces a cleaner
    // error code (`confirm_public_required`) regardless of what the
    // server decides to do in the future.
    if (level === "public" && !opts.confirmPublic) {
      out.error({
        code: "confirm_public_required",
        message:
          "Setting visibility to 'public' requires --confirm-public. Public posts are accessible to anyone with the link.",
      });
      return;
    }

    try {
      out.spin(
        `Setting visibility of ${brand.muted(postId)} to ${brand.value(level)}...`,
      );

      const client = createApiClient(config);
      const result = await client.changeVisibility(postId, level, {
        workspaceId: config.workspaceId,
        projectId: config.projectId,
        confirmPublic: opts.confirmPublic,
      });

      out.succeed(
        `Visibility of ${brand.muted(postId)} is now ${level === "public" ? brand.success(level) : brand.value(level)}`,
      );
      out.result(result);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });
