import { Command } from "commander";
import readline from "node:readline";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

/**
 * Hard-deletes a post. Two layers of safety separate this from `unpublish`
 * (which just hides the post):
 *
 *   1. `--yes` / `-y` — explicit opt-in for scripts and agents. This is the
 *      primary rail: any non-TTY invocation (CI, pipe-in, agent) MUST pass
 *      this flag, otherwise the command refuses and exits 1.
 *   2. Interactive confirmation — only applies when both stdin and stdout are
 *      TTYs (a human sitting at a terminal). We ask them to re-type the
 *      idOrSlug they passed, to guard against muscle-memory `y\n`.
 *
 * The server endpoint (`DELETE /api/v1/posts/:postId`) is the same operation
 * the dashboard's "Delete" button triggers — versions, tags, and the slug
 * reservation are all removed in a single transaction.
 */
export const deleteCommand = new Command("delete")
  .description(
    "Permanently delete a post (cannot be undone). Use `unpublish` to just hide it.",
  )
  .argument("<idOrSlug>", "Post ID (UUID) or slug — see `opendocs list`")
  .option(
    "-y, --yes",
    "Skip the interactive confirmation. Required in non-TTY contexts (scripts, agents, CI).",
  )
  .action(async (postId: string, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();

    if (globalOpts.apiUrl) {
      config.apiUrl = globalOpts.apiUrl;
    }

    // Confirmation gate. `--yes` short-circuits everything; otherwise we
    // branch on TTY: humans get the interactive prompt, scripts get a hard
    // rejection so no destructive action ever happens silently.
    if (!opts.yes) {
      const isInteractive = Boolean(
        process.stdin.isTTY && process.stdout.isTTY,
      );

      if (!isInteractive) {
        out.error({
          code: "confirm_required",
          message:
            "Refusing to delete without confirmation. Pass --yes (or -y) to confirm deletion in non-interactive contexts.",
        });
        return;
      }

      const confirmed = await promptForConfirmation(postId);
      if (!confirmed) {
        // Deliberate no-op — NOT an error. The user cancelled.
        out.info(brand.muted("Cancelled. No post was deleted."));
        return;
      }
    }

    try {
      out.spin(`Deleting ${brand.muted(postId)}...`);

      const client = createApiClient(config);
      const result = await client.deletePost(postId, {
        workspaceId: config.workspaceId,
      });

      out.succeed(
        `Post ${brand.muted(postId)} deleted permanently. This cannot be undone.`,
      );
      if (result.slug) {
        out.info(
          brand.muted(
            `The slug '${result.slug}' is now free to reuse in this workspace.`,
          ),
        );
      }
      out.result(result);
    } catch (err: unknown) {
      const error = err as { status?: number; code?: string; message: string };
      out.error(error);
    }
  });

/**
 * Prompts the user to re-type `idOrSlug` to confirm. Returns true if they
 * typed it exactly, false otherwise (including when they hit Ctrl-D).
 *
 * We echo the expected string back so the user doesn't have to scroll up to
 * remember what they typed — the whole point is to make the confirmation a
 * deliberate act, not a muscle-memory one.
 */
async function promptForConfirmation(idOrSlug: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    process.stdout.write(
      `\n${brand.warn("⚠")}  This will permanently delete the post and free its slug.\n`,
    );
    process.stdout.write(
      `   Type ${brand.value(idOrSlug)} to confirm, or anything else to cancel: `,
    );
    rl.once("line", (answer) => {
      rl.close();
      resolve(answer.trim() === idOrSlug);
    });
    rl.once("close", () => {
      // Ctrl-D or EOF before a line was received: treat as cancel.
      resolve(false);
    });
  });
}
