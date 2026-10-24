import { Command } from "commander";
import readline from "node:readline";
import { getConfigOrExit, saveConfig, type CliConfig } from "../lib/config.js";
import { ApiError, createApiClient } from "../lib/api.js";
import { createOutput, brand, type Output } from "../lib/output.js";

type Client = ReturnType<typeof createApiClient>;

/**
 * `opendocs team …` — everything about who is in a workspace, modelled on
 * here.now's members/invites/auto-join:
 *
 *   admins:   list · invite · revoke · resend · role · remove · auto-join
 *   invitees: invitations · join · decline · leave
 *
 * Invites always go out by email and the person accepts (from the email,
 * or with `opendocs team join` once signed in with that verified address),
 * so nobody is added to a workspace without confirming.
 */

function setup(cmd: Command) {
  const globalOpts = cmd.optsWithGlobals();
  const out = createOutput(globalOpts.json);
  const config = getConfigOrExit();
  if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
  return { out, config, client: createApiClient(config) };
}

function requireWorkspace(out: Output, config: CliConfig): string | null {
  if (!config.workspaceId) {
    out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
    return null;
  }
  return config.workspaceId;
}

async function confirm(out: Output, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    out.error({
      code: "confirm_required",
      message: `${question} Pass --yes to confirm in non-interactive contexts.`,
    });
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function findMember(client: Client, workspaceId: string, email: string) {
  const { members } = await client.listMembers(workspaceId);
  const member = members.find((m) => m.email?.toLowerCase() === email.trim().toLowerCase());
  if (!member?.id) {
    throw new ApiError(404, "member_not_found", `${email} is not a member of this workspace. Run \`opendocs team list\`.`);
  }
  return member as typeof member & { id: string };
}

async function findInvitation(client: Client, workspaceId: string, email: string) {
  const { invitations } = await client.listInvitations(workspaceId);
  const invitation = invitations.find((i) => i.email.toLowerCase() === email.trim().toLowerCase());
  if (!invitation) {
    throw new ApiError(404, "invitation_not_found", `No pending invitation for ${email}. Run \`opendocs team list\`.`);
  }
  return invitation;
}

function switchTo(config: CliConfig, workspace: { id: string; name: string; slug: string }) {
  saveConfig({
    ...config,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    projectId: undefined,
    projectName: undefined,
    projectSlug: undefined,
  });
}

function fail(out: Output, err: unknown) {
  out.error(err as { status?: number; code?: string; message: string });
}

export const teamCommand = new Command("team")
  .description("Members, invitations and auto-join for the active workspace (and invitations sent to you)");

async function listTeam(cmd: Command) {
  const { out, config, client } = setup(cmd);
  const workspaceId = requireWorkspace(out, config);
  if (!workspaceId) return;
  try {
    out.spin("Fetching team...");
    const { members } = await client.listMembers(workspaceId);
    // Pending invitations and auto-join rules are admin views; members get 403.
    const invitations = await client.listInvitations(workspaceId).then((r) => r.invitations).catch(() => null);
    const autoJoin = await client.autoJoinDomains(workspaceId).then((r) => r.domains).catch(() => []);
    out.stopSpinner();
    out.info(brand.label(`Members of ${config.workspaceName ?? config.workspaceSlug ?? "the workspace"}:`));
    for (const m of members) {
      out.info(`  ${brand.value(m.name || m.email || "?")} ${brand.muted(m.email ?? "")} ${brand.purple(m.role)}`);
    }
    if (invitations && invitations.length > 0) {
      out.info(brand.label("Pending invitations:"));
      for (const i of invitations) out.info(`  ${i.email} ${brand.muted(i.role)}`);
    }
    if (autoJoin.length > 0) {
      out.info(brand.label(`Auto-join: anyone with ${autoJoin.map((d) => `@${d.domain}`).join(", ")} can join`));
    }
    out.result({ workspaceId, members, invitations: invitations ?? [], autoJoinDomains: autoJoin.map((d) => d.domain) });
  } catch (err) {
    fail(out, err);
  }
}

teamCommand.action(async (_opts, cmd) => listTeam(cmd));

teamCommand
  .command("list")
  .alias("ls")
  .description("Members, pending invitations and auto-join domains")
  .action(async (_opts, cmd) => listTeam(cmd));

teamCommand
  .command("invite")
  .description("Invite people by email. They get a link and must accept before they're added.")
  .argument("<emails...>", "One or more email addresses")
  .option("--role <role>", "member | admin", "member")
  .action(async (emails: string[], opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    if (opts.role !== "member" && opts.role !== "admin") {
      out.error({ code: "invalid_role", message: '--role must be "member" or "admin".' });
      return;
    }
    const results: Array<{ email: string; success: boolean; error?: string; message?: string }> = [];
    for (const email of emails.flatMap((e) => e.split(",")).map((e) => e.trim()).filter(Boolean)) {
      try {
        await client.inviteMember({ email, role: opts.role, workspaceId });
        out.succeed(`Invited ${brand.value(email)} as ${opts.role} — they'll get an email to accept`);
        results.push({ email, success: true });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        out.fail(`${email}: ${e.message ?? "invite failed"}`);
        results.push({ email, success: false, error: e.code, message: e.message });
      }
    }
    out.result({ workspaceId, results });
    if (results.some((r) => !r.success)) process.exit(1);
  });

teamCommand
  .command("revoke")
  .description("Cancel a pending invitation")
  .argument("<email>")
  .action(async (email: string, _opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      const invitation = await findInvitation(client, workspaceId, email);
      await client.revokeInvitation(invitation.id);
      out.succeed(`Revoked the invitation for ${brand.value(email)}`);
      out.result({ success: true, email, invitationId: invitation.id });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("resend")
  .description("Email a pending invitation again")
  .argument("<email>")
  .action(async (email: string, _opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      const invitation = await findInvitation(client, workspaceId, email);
      await client.resendInvitation(invitation.id);
      out.succeed(`Resent the invitation to ${brand.value(email)}`);
      out.result({ success: true, email, invitationId: invitation.id });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("role")
  .description("Change a member's role")
  .argument("<email>")
  .argument("<role>", "admin | member")
  .action(async (email: string, role: string, _opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    if (role !== "admin" && role !== "member") {
      out.error({ code: "invalid_role", message: 'Role must be "admin" or "member".' });
      return;
    }
    try {
      const member = await findMember(client, workspaceId, email);
      await client.changeMemberRole(member.id, role);
      out.succeed(`${brand.value(email)} is now ${role}`);
      out.result({ success: true, email, role });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("remove")
  .description("Remove a member from the workspace")
  .argument("<email>")
  .option("-y, --yes", "Skip confirmation (required for agents/CI)")
  .action(async (email: string, opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      const member = await findMember(client, workspaceId, email);
      if (!(await confirm(out, Boolean(opts.yes), `Remove ${email} from ${config.workspaceName ?? "the workspace"}?`))) return;
      await client.removeMember(member.id);
      out.succeed(`Removed ${brand.value(email)}`);
      out.result({ success: true, email });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("leave")
  .description("Leave the active workspace")
  .option("-y, --yes", "Skip confirmation (required for agents/CI)")
  .action(async (opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      if (!(await confirm(out, Boolean(opts.yes), `Leave ${config.workspaceName ?? "the workspace"}?`))) return;
      const result = await client.leaveWorkspace(workspaceId);
      const next = result.remainingWorkspaces[0];
      if (next) switchTo(config, next);
      out.succeed(`Left ${brand.value(config.workspaceName ?? "the workspace")}${next ? ` — now using ${brand.value(next.name)}` : ""}`);
      out.result({ ...result, activeWorkspace: next ?? null });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("invitations")
  .description("Invitations sent to you, and workspaces you can join with your email domain")
  .action(async (_opts, cmd) => {
    const { out, client } = setup(cmd);
    try {
      const data = await client.myInvitations();
      if (!data.emailVerified) {
        out.warn("Your email isn't verified, so invitations can't be shown. Sign in with `opendocs login --email <you@example.com>` to verify it.");
      }
      for (const i of data.invitations) {
        out.info(`${brand.purple("•")} ${brand.value(i.workspaceName)} ${brand.muted(`(${i.workspaceSlug})`)} as ${i.role}${i.invitedByName ? ` — invited by ${i.invitedByName}` : ""}`);
      }
      for (const j of data.joinable) {
        out.info(`${brand.purple("•")} ${brand.value(j.workspaceName)} ${brand.muted(`(${j.workspaceSlug})`)} — open to @${j.domain}`);
      }
      if (data.invitations.length + data.joinable.length === 0) {
        out.info("No pending invitations.");
      } else {
        out.info(brand.muted(`Join with ${brand.purple("opendocs team join <workspace>")}`));
      }
      out.result(data);
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("join")
  .description("Accept an invitation (or join via your email domain) and switch to that workspace")
  .argument("[workspace]", "Workspace slug; optional when there's only one option")
  .option("--no-switch", "Join without making it the active workspace")
  .action(async (workspace: string | undefined, opts, cmd) => {
    const { out, config, client } = setup(cmd);
    try {
      const data = await client.myInvitations();
      const options = [
        ...data.invitations.map((i) => ({ kind: "invite" as const, slug: i.workspaceSlug, id: i.id, name: i.workspaceName })),
        ...data.joinable.map((j) => ({ kind: "domain" as const, slug: j.workspaceSlug, id: j.workspaceId, name: j.workspaceName })),
      ];
      const choice = workspace
        ? options.find((o) => o.slug === workspace.toLowerCase() || o.id === workspace)
        : options.length === 1
          ? options[0]
          : undefined;
      if (!choice) {
        out.error({
          code: options.length === 0 ? "no_invitations" : "workspace_required",
          message:
            options.length === 0
              ? data.emailVerified
                ? "No pending invitations or joinable workspaces for your email."
                : "Your email isn't verified. Sign in with `opendocs login --email <you@example.com>` first."
              : `Pick one: ${options.map((o) => o.slug).join(", ")} — e.g. opendocs team join ${options[0].slug}`,
        });
        return;
      }
      const result =
        choice.kind === "invite" ? await client.acceptInvitation(choice.id) : await client.joinWorkspace(choice.slug);
      if (opts.switch) switchTo(config, result.workspace);
      out.succeed(
        `${result.alreadyMember ? "Already a member of" : "Joined"} ${brand.value(result.workspace.name)} as ${result.role}${opts.switch ? " and switched to it" : ""}`,
      );
      out.result({ ...result, via: choice.kind, active: Boolean(opts.switch) });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("decline")
  .description("Decline an invitation")
  .argument("<workspace>", "Workspace slug from `opendocs team invitations`")
  .action(async (workspace: string, _opts, cmd) => {
    const { out, client } = setup(cmd);
    try {
      const { invitations } = await client.myInvitations();
      const invitation = invitations.find((i) => i.workspaceSlug === workspace.toLowerCase());
      if (!invitation) {
        out.error({ code: "invitation_not_found", message: `No pending invitation to "${workspace}".` });
        return;
      }
      await client.declineInvitation(invitation.id);
      out.succeed(`Declined the invitation to ${brand.value(invitation.workspaceName)}`);
      out.result({ success: true, workspaceSlug: invitation.workspaceSlug });
    } catch (err) {
      fail(out, err);
    }
  });

teamCommand
  .command("auto-join")
  .description("Let anyone with a verified email at your domain join (admins). `auto-join add acme.com`, `auto-join remove acme.com`, or no args to list.")
  .argument("[action]", "add | remove")
  .argument("[domain]", "Your company's email domain, e.g. acme.com")
  .action(async (action: string | undefined, domain: string | undefined, _opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      let domains;
      if (!action) {
        domains = (await client.autoJoinDomains(workspaceId)).domains;
      } else if ((action === "add" || action === "remove") && domain) {
        domains = (
          action === "add"
            ? await client.addAutoJoinDomain(workspaceId, domain)
            : await client.removeAutoJoinDomain(workspaceId, domain)
        ).domains;
        out.succeed(
          action === "add"
            ? `Anyone with a verified @${domain.replace(/^@/, "")} email can now join ${config.workspaceName ?? "the workspace"}`
            : `Removed auto-join for @${domain.replace(/^@/, "")}`,
        );
      } else {
        out.error({ code: "invalid_arguments", message: "Usage: opendocs team auto-join [add|remove <domain>]" });
        return;
      }
      if (!action) {
        out.info(domains.length ? `Auto-join domains: ${domains.map((d) => `@${d.domain}`).join(", ")}` : "No auto-join domains.");
      }
      out.result({ workspaceId, domains: domains.map((d) => d.domain) });
    } catch (err) {
      fail(out, err);
    }
  });
