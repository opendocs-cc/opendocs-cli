import { Command } from "commander";
import { getConfigOrExit } from "../lib/config.js";
import { createApiClient } from "../lib/api.js";
import { createOutput, brand } from "../lib/output.js";

export const inviteCommand = new Command("invite")
  .description("Invite teammates to the active workspace by email")
  .argument("<emails...>", "One or more email addresses")
  .option("--role <role>", "member | admin", "member")
  .action(async (emails: string[], opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const config = getConfigOrExit();
    if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
    if (!config.workspaceId) {
      out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
      return;
    }
    if (opts.role !== "member" && opts.role !== "admin") {
      out.error({ code: "invalid_role", message: `--role must be "member" or "admin".` });
      return;
    }

    const client = createApiClient(config);
    const results: Array<{ email: string; success: boolean; error?: string; message?: string }> = [];
    for (const email of emails.flatMap((e) => e.split(",")).map((e) => e.trim()).filter(Boolean)) {
      try {
        await client.inviteMember({ email, role: opts.role, workspaceId: config.workspaceId });
        out.succeed(`Invited ${brand.value(email)} to ${brand.value(config.workspaceName ?? "the workspace")} as ${opts.role}`);
        results.push({ email, success: true });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        out.fail(`${email}: ${e.message ?? "invite failed"}`);
        results.push({ email, success: false, error: e.code, message: e.message });
      }
    }
    out.result({ workspaceId: config.workspaceId, results });
    if (results.some((r) => !r.success)) process.exit(1);
  });
