import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_IDS,
  SKILL_NAME,
  installSkillFolder,
  isAgentDetected,
  normalizeAgentId,
  realTarget,
  resolveAgents,
  type InstallOutcome,
  type InstallStatus,
  type SkillAgent,
  type SkillFile,
} from "../lib/agent-skills.js";
import { brand, createOutput, type Output } from "../lib/output.js";
import { formatColumns, tildify, tildifyText } from "../lib/display.js";
import { addMcpServer, type McpAddStatus, type McpRun } from "../lib/mcp.js";
import { printMcpResults } from "./mcp.js";
import { CLI_VERSION } from "../lib/version.js";

type AgentGuideVariant = "concise" | "full" | "api" | "cli";

const CONCISE_GUIDE = `# OpenDocs Agent Guide

OpenDocs publishes Markdown to shareable URLs and can export those docs to PDF or DOCX.

## Getting started (no browser needed)

1. Check \`opendocs whoami --json\`. If it says not logged in, ask the user for their email address.
2. Run \`opendocs login --email <email> --json\`. It emails a 6-digit code and exits (\`status: "code_sent"\`).
3. Ask the user: "Check your inbox for a code from OpenDocs and paste it here."
4. Run \`opendocs login --email <email> --code <code> --json\`. New emails get an account, a workspace and an API key automatically; the key is saved for you. Never ask the user to copy keys around.

Sign the user up before their first publish: it's free for up to 50 documents, and their links stay up, private to their workspace. Only if they don't want an account yet: \`opendocs publish doc.md --anonymous --json\` gives a link anyone can open for 24 hours plus a claim URL. Tell the user it expires and offer to sign them up to keep it; logging in later from the same folder claims it automatically.

## MCP

OpenDocs also runs a remote MCP server at \`https://mcp.opendocs.cc/mcp\`; each app signs the user in with OAuth the first time (no API key). If OpenDocs MCP tools are available and you can't run shell commands, use them. With a shell, prefer the CLI for local files, folders and images. \`opendocs mcp add\` registers the server in the coding tools on this machine (\`--dry-run\` previews it); \`opendocs mcp connect claude\` (or \`chatgpt\`) opens the app's add-connector page with the URL on the clipboard.

## Agent defaults

- Use \`--json\` for commands you need to parse. Errors (JSON on stderr) carry \`error\` and \`message\`.
- Re-publishing a file this folder already published updates the same document (tracked in \`.opendocs/state.json\`) — don't use \`update\` or worry about duplicates. Use \`--new\` only to deliberately create a copy.
- A \`version_conflict\` means someone else published a newer version. Show the user, then pull it or re-run with \`--force\` only if they agree.
- Default visibility is \`workspace\`. Never use \`--visibility public --confirm-public\` unless the user explicitly asked for public sharing.
- To share with someone outside the workspace, use \`opendocs share <doc> <email>\` instead of making it public.
- Prefer one batch command over loops. \`opendocs publish ./folder --tags <tag> --json\` recursively uploads Markdown files and auto-chunks.
- \`--project "Name"\` creates the project the first time.
- Keep the workspace organized: treat projects like git branches (one per client, repo, product or initiative). Before publishing, check \`opendocs project current --json\` and \`opendocs project list --json\` (\`recentTitles\`). If the doc belongs elsewhere, use \`--project <slug>\`; if it starts a new ongoing topic, ask the user before creating a project — unless \`opendocs whoami --json\` says \`organize: "auto"\` (then create it and say so) or \`"off"\`. In a repo dedicated to one topic, \`opendocs project link "<name>"\` once. Never make a project for a one-off doc.
- Adding a teammate sends an email they must accept: confirm the email and role with the user, then \`opendocs team invite <email>\`. If login reports \`pendingInvitations\`, ask before \`opendocs team join\`.
- The export theme (brand color, font, logo, footer) changes every PDF and Word file in the workspace. Propose a preset (\`opendocs theme presets\`) or a dark color + font, get the user's OK, then \`opendocs theme set ... --yes\`. Brand colors must be dark (4.5:1+ on white, ideally 7:1; check with \`opendocs theme check <hex>\`). Export one doc afterwards as a preview. Color, font, presets and logo work on every plan; only \`theme footer\` needs Pro or Team.
- Link related docs to each other (inline, a short "Related" list, an overview doc per project). Use full URLs from the \`url\` field of \`publish --json\` / \`list --json\`: Default project docs are \`https://opendocs.cc/<workspace>/<slug>\`, other projects \`https://opendocs.cc/<workspace>/projects/<project>/<slug>\`. Local \`./file.md\` links are not rewritten. For a batch: publish once, swap in the URLs, publish again. \`move\` changes a doc's URL, so update links to it.

## Core commands

\`\`\`bash
opendocs publish doc.md --json
opendocs publish ./docs --project "Client X" --tags project-docs --json
opendocs publish report.md --export pdf --json
opendocs publish doc.md --anonymous --json
opendocs clone --json                      # whole workspace into ./<workspace>
opendocs status --json                     # what changed locally / online
opendocs history <doc> --json
opendocs rollback <doc> <version> --json
opendocs move <doc> --project "Archive" --json
opendocs share <doc> sam@acme.com @acme.com --json
opendocs team invite dana@acme.com --json
opendocs team list --json
opendocs team join --json
opendocs theme --json                      # export theme: color, font, logo, footer
opendocs theme set --preset boardroom --yes --json   # only after the user agreed
opendocs project link "Acme launch" --json
opendocs config set organize auto --json
opendocs workspace create "Acme Research" --json
opendocs list --project <slug> --json --limit 100
opendocs get <id-or-slug> --json
opendocs pull <id-or-slug> --stdout
opendocs export <id-or-slug> --format pdf
opendocs export --project <slug> --format pdf
opendocs visibility <id-or-slug> public --confirm-public
opendocs unpublish <id-or-slug>
opendocs delete <id-or-slug> --yes
\`\`\`

\`<doc>\` can be a post ID, slug, or a local .md file this folder published.

## What to tell the user

- Put each URL on its own line with nothing after it (chat clients glue trailing punctuation into links).
- Say who can open it: "workspace members", "only you", "people you shared it with", or "anyone with the link for 24 hours" (anonymous).
- For anonymous docs, share the claim URL exactly as returned and say it expires in 24 hours.
- After \`--export\`, give the local file path.

## Limits to remember

- Markdown: 1 MB per document (256 KB anonymous).
- Publish: 500 files per CLI invocation, auto-chunked into 25 docs per API request. Anonymous: 10 files.
- Folder publish skips \`.obsidian\`, \`.trash\`, \`.git\`, \`.hg\`, \`.opendocs\`, and \`node_modules\`.
- Export: 10 posts per batch (\`--project\` batches for you).
- Free plan: 50 published docs per workspace, PDF only, "Made with OpenDocs" footer. Export branding (logo, color, font, presets) is included.
- Pro/Team: unlimited docs, DOCX export, your own export footer, integrations (Google Drive, signatures).

## Recovery

- \`not_logged_in\`: sign the user up ("Getting started" above). Use \`--anonymous\` only if they don't want an account and agree to a public 24-hour link.
- \`invalid_code\` / \`code_expired\`: ask for the latest code, or request a new one.
- \`document_limit\`: publish would exceed the Free cap. Ask the user to upgrade, unpublish old docs, or publish fewer files.
- \`version_conflict\`: see Agent defaults.
- \`too_many_files\`: split into multiple publish invocations.
- \`too_many_posts\`: split export into groups of 10.
- Batch publish can partially fail while still exiting 0. Inspect \`failed\` and \`results[].success\`.
`;

const CLI_GUIDE = `# OpenDocs CLI Agent Reference

## Global behavior

- \`--json\` makes stdout a single JSON object and writes classified errors to stderr.
- \`--api-url <url>\` overrides \`https://api.opendocs.cc\`.
- Config is stored in \`~/.config/opendocs/config.json\`.
- API keys start with \`od_live_\`.

## Auth and workspace

\`\`\`bash
opendocs login --email you@example.com --json            # emails a 6-digit code
opendocs login --email you@example.com --code 123456 --json
opendocs login --key od_live_xxxxx --json
opendocs whoami --json
opendocs workspace list --json
opendocs workspace use <slug> --json
opendocs workspace create "Acme Research" [--slug acme] --json
opendocs workspace members --json
opendocs team invite sam@acme.com [--role admin] --json
opendocs team list | resend | revoke | role <email> <role> | remove <email> --yes
opendocs team invitations | join [workspace] | decline <workspace> | leave --yes
opendocs team auto-join [add|remove <domain>]
opendocs theme [show] | presets | fonts | check <hex>
opendocs theme set [--preset <id>] [--color <hex>] [--font <name>] [--logo-in-exports on|off] --yes
opendocs theme footer [--company ..] [--tagline ..] [--link-url ..] [--link-label ..] [--on|--off] --yes
opendocs theme logo <file.png> --yes | --remove --yes
opendocs project link "<name>" | unlink | current
opendocs config get | set organize ask|auto|off
\`\`\`

\`login --email\` creates the account (username, workspace, default project) if the email is new. \`signup\` is an alias.

\`publish\`, \`update\`, \`export\`, \`get\`, \`pull\`, \`visibility\`, \`unpublish\`, and \`delete\` use the CLI's active workspace/project for slug disambiguation. \`opendocs workspace use <slug>\` resets the active project to that workspace's Default project.

## Projects

Use projects when a group of docs belongs together, such as a repo, product,
launch, client, or experiment. Default project docs use \`/<workspace>/<post>\`;
named project docs use \`/<workspace>/projects/<project>/<post>\`.

\`\`\`bash
opendocs project list --json
opendocs project current --json
opendocs project create "Launch docs" --slug launch-docs --use --json
opendocs project use launch-docs --json
opendocs publish ./docs --project launch-docs --tags launch --json
opendocs list --all-projects --json --limit 100
\`\`\`

## Publish

\`\`\`bash
opendocs publish doc.md --json
opendocs publish ./vault --tags obsidian-import --json
opendocs publish ./docs --export pdf --tags release-q2 --json
\`\`\`

Flags: \`--title\`, \`--slug\` (single-file only), \`--visibility private|workspace|public\`, \`--confirm-public\`, \`--tags a,b\`, \`--project name-slug-or-id\` (created if new), \`--export pdf|docx\`, \`--anonymous\`, \`--new\`, \`--force\`.

Files this folder already published are updated, not duplicated (\`.opendocs/state.json\`). Updates send the last-synced version; if someone published since, that file reports \`version_conflict\` and is left alone unless you pass \`--force\`. Identical content reports \`unchanged\` without a new version.

## Sync a folder

\`\`\`bash
opendocs clone [dir] [--project <slug>] --json
opendocs status --json
opendocs publish . --json
opendocs pull <file.md> -o <file.md>      # bring a "behind" file up to date
\`\`\`

Limits: 1 MB Markdown per doc, 500 files per invocation, 25 docs per publish batch. Folder publish is recursive and skips \`.obsidian\`, \`.trash\`, \`.git\`, \`.hg\`, \`.opendocs\`, and \`node_modules\`.

Local Markdown/HTML image references are uploaded before publish when possible. Missing or unsupported individual images are warnings; the original reference remains.

## Read and update

\`\`\`bash
opendocs list --json --limit 100
opendocs list --all --json --limit 100
opendocs list --tag <tag> --json
opendocs get <id-or-slug> --json
opendocs pull <id-or-slug> --stdout
opendocs pull --project --output ./docs --json
opendocs pull --workspace --dry-run --json
opendocs update revised.md --post-id <id-or-slug> --json
\`\`\`

\`update\` creates a new version and keeps the URL stable. Omitted \`--visibility\` and \`--tags\` preserve the current values. It does not support \`--export\`; export separately after updating.

## Export and visibility

\`\`\`bash
opendocs export <id-or-slug> --format pdf
opendocs export a b c --format docx -o ./exports
opendocs visibility <id-or-slug> public --confirm-public
opendocs unpublish <id-or-slug>
opendocs delete <id-or-slug> --yes
\`\`\`

Batch export accepts up to 10 IDs/slugs and writes files locally from a zip manifest; \`export --project <slug>\` exports a whole project. \`delete --yes\` is required in non-interactive agent contexts.

## History, moving and sharing

\`\`\`bash
opendocs history <doc> --json
opendocs pull <doc> --version 2 --stdout
opendocs rollback <doc> 2 --json
opendocs move <doc> --project "Archive" --json
opendocs share <doc> sam@acme.com @acme.com --json
opendocs share <doc> --json                       # list
opendocs share <doc> sam@acme.com --remove --json
opendocs claim [claim-url] --json
\`\`\`

Rollback publishes the old content as a new version. Shared people sign in with that (verified) email to read; they don't join the workspace.

## MCP server

\`https://mcp.opendocs.cc/mcp\` (OAuth: each tool signs the user in the first time; no API key is written anywhere).

\`\`\`bash
opendocs mcp url --json                          # { url, name, displayName }
opendocs mcp add [--agent <ids...>] [--dry-run] --json
opendocs mcp remove [--agent <ids...>] [--dry-run] --json
opendocs mcp connect claude|chatgpt --json       # { app, openUrl, url, copied }; no browser with --json
opendocs agent --install --mcp                   # skill + MCP server for the same agents
\`\`\`

\`mcp add\` uses \`claude mcp add\` / \`code --add-mcp\` when they're on PATH and otherwise merges the tool's MCP config (Codex config.toml, Cursor, VS Code, Windsurf, Gemini, opencode, Kiro). \`results[]\` has \`agent\`, \`name\`, \`status\` (\`added\`, \`updated\`, \`already_present\`, \`manual\`, \`skipped\`, \`failed\`), \`method\` (\`cli\` or \`config\`) and \`path\` / \`command\` / \`message\`. For \`manual\`, show the user the \`message\`. It exits 1 only when something \`failed\`.
`;

const API_GUIDE = `# OpenDocs Public API Agent Reference

Base URL: \`https://api.opendocs.cc\`

Auth: \`Authorization: Bearer od_live_...\`

Chat apps and agents without a shell can use the remote MCP server at \`https://mcp.opendocs.cc/mcp\` instead (OAuth sign-in, no API key): https://opendocs.cc/mcp

API-key-compatible endpoints for agents and backend tools:

| Task | Endpoint | Notes |
|---|---|---|
| Current user + quota | \`GET /api/v1/me?workspaceId=ws_...\` | Pass \`workspaceId\` for multi-workspace quota checks. |
| List workspaces | \`GET /api/v1/workspaces\` | Returns active memberships. |
| Publish one doc | \`POST /api/v1/publish\` | Requires \`markdown\` and \`workspaceId\`; max 1 MB Markdown. |
| Publish many docs | \`POST /api/v1/publish/batch\` | Max 25 docs; JSON returns \`207\`, SSE streams \`result\` and \`summary\`. |
| List posts | \`GET /api/v1/posts?workspaceId=...&tag=...&page=1&limit=100\` | Omit \`workspaceId\` to list across workspaces authored by caller. |
| Get metadata | \`GET /api/v1/posts/:idOrSlug?workspaceId=...\` | \`workspaceId\` disambiguates slugs. |
| Pull Markdown | \`GET /api/v1/posts/:idOrSlug/raw?workspaceId=...\` | Returns current raw Markdown. |
| Update | \`POST /api/v1/posts/:idOrSlug/update?workspaceId=...\` | Creates a new version; URL stays stable. |
| Unpublish | \`POST /api/v1/posts/:idOrSlug/unpublish?workspaceId=...\` | Takes it offline (content, history and slug kept; can't be republished); frees Free-plan slot if published. |
| Visibility | \`POST /api/v1/posts/:idOrSlug/visibility?workspaceId=...\` | \`public\` requires \`confirmPublic: true\`. |
| Tags | \`PATCH /api/v1/posts/:idOrSlug/tags?workspaceId=...\` | Incrementally add/remove tags. |
| Delete | \`DELETE /api/v1/posts/:idOrSlug?workspaceId=...\` | Permanent; frees slug and quota slot. |
| Export one | \`POST /api/v1/posts/:idOrSlug/export/:format?workspaceId=...\` | \`format\` is \`pdf\` or \`docx\`. |
| Export many | \`POST /api/v1/posts/batch/export\` | Max 10 posts; returns zip plus manifest. |
| Versions | \`GET /api/v1/posts/:idOrSlug/versions\` | Newest first, with \`client\` attribution. |
| Old version | \`GET /api/v1/posts/:idOrSlug/versions/:n/raw\` | Raw Markdown of version \`n\`. |
| Roll back | \`POST /api/v1/posts/:idOrSlug/versions/:n/restore\` | Publishes version \`n\` again as a new version. |
| Move | \`POST /api/v1/posts/:idOrSlug/move\` | Body \`{ "projectSlug": "..." }\`. |
| Share | \`GET/POST/DELETE /api/v1/posts/:idOrSlug/share\` | Body \`{ "emails": [...], "domains": [...] }\`. |
| Create workspace | \`POST /api/v1/workspaces\` | Body \`{ "name": "...", "slug": "..." }\`. |
| Invite | \`POST /api/v1/workspace/team/invite\` | Body \`{ "email", "role", "workspaceId" }\`. |
| Team admin | \`GET /api/v1/workspace/team\`, \`GET .../team/invitations\`, \`DELETE .../invitations/:id\`, \`PATCH .../members/:id/role\`, \`DELETE .../members/:id\` | All accept API keys; \`workspaceId\` query on GETs. |
| My invitations | \`GET /api/v1/me/invitations\` | Invitations to your verified email + \`joinable\` workspaces (domain auto-join). |
| Accept / decline | \`POST /api/v1/invitations/:id/accept\`, \`.../decline\` | Verified email required. |
| Join by domain | \`POST /api/v1/workspaces/:slug/join\` | When an auto-join domain matches your verified email. |
| Auto-join rules | \`GET/POST/DELETE /api/v1/workspace/auto-join\` | Admins; only their own email domain, no consumer domains. |
| Leave | \`POST /api/v1/workspace/leave\` | Body \`{ "workspaceId" }\`; owners can't leave. |
| Export theme | \`GET /api/v1/workspace/branding?workspaceId=\` | Current color, font, logo, footer + \`presets\`, \`fonts\`, \`guidelines\`. |
| Change theme | \`PATCH /api/v1/workspace/branding\` | Body \`{ "workspaceId", "preset"?, "brandColor"?, "font"?, "showLogoInExports"?, "footer"? }\`. Owners/admins on any plan; \`footer\` needs Pro+ (Free keeps "Made with OpenDocs"). \`low_contrast\` if the color is lighter than 4.5:1 on white. |
| Logo | \`POST /api/v1/workspace/logo/upload\` (multipart \`file\`, \`workspaceId\`) | PNG/JPEG/WebP, max 2 MB. Remove with \`POST /api/v1/workspace/logo\` \`{ "workspaceId", "logoUrl": null }\`. |

No API key needed:

| Task | Endpoint | Notes |
|---|---|---|
| Email a sign-in code | \`POST /api/v1/auth/code/request\` | Body \`{ "email" }\`. |
| Verify code → API key | \`POST /api/v1/auth/code/verify\` | Body \`{ "email", "code", "keyName" }\`; creates the account if new. |
| Anonymous publish | \`POST /api/v1/anonymous/publish\` | 24-hour link + \`claimToken\`/\`claimUrl\`. Max 256 KB. |
| Update anonymous | \`PUT /api/v1/anonymous/:id\` | Body includes \`claimToken\`. |
| Claim anonymous | \`POST /api/v1/anonymous/claim\` | Needs an API key; body \`{ "claimToken", "workspaceId" }\`. |

Send \`X-OpenDocs-Client: <agent>\` (e.g. \`claude-code\`) on every request so versions show which agent published them. Updates accept \`baseVersionNumber\` and return \`409 version_conflict\` when the post moved past it.

Publish body:

\`\`\`json
{
  "markdown": "# Title\\n\\nBody",
  "workspaceId": "ws_123",
  "visibility": "workspace",
  "tags": ["docs"],
  "sourcePath": "docs/title.md"
}
\`\`\`

Public publish requires:

\`\`\`json
{ "visibility": "public", "confirmPublic": true }
\`\`\`

API \`url\` fields are relative paths like \`/<workspace-slug>/<post-slug>\`. Prepend \`https://opendocs.cc\` when showing a full URL.
`;

export const agentCommand = new Command("agent")
  .description("Print OpenDocs instructions for AI agents, or install them as a skill")
  .option("--full", "Print the full bundled SKILL.md")
  .option("--api", "Print API-only reference")
  .option("--cli", "Print CLI-only reference")
  .option(
    "--install [dir]",
    "Install the skill (SKILL.md + scripts/opendocs.sh) for every detected agent, or into <dir>",
  )
  .option(
    "--agent <ids...>",
    "Install only for these agents, even if not detected (implies --install)",
  )
  .option(
    "--mcp",
    "Also register the OpenDocs MCP server in the same agents (see opendocs mcp add; implies --install)",
  )
  .option("--list", "List supported agents, their skills folders and whether they're detected")
  .addHelpText(
    "after",
    `
Agents (ids for --agent):
  ${wrapList(AGENT_IDS, 70).join("\n  ")}

Most agents read the shared ~/.agents/skills folder, so they share one copy.
Only <skills folder>/opendocs is written; nothing is deleted, and a symlinked
skill folder is reported and left alone. Re-running updates changed files only.

Examples:
  opendocs agent --install                      # every detected agent
  opendocs agent --install --agent claude-code codex
  opendocs agent --install --mcp                # also add the OpenDocs MCP server
  opendocs agent --list
  opendocs agent --install ./.claude/skills/opendocs   # a folder of your choice
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    const out = createOutput(globalOpts.json);
    const selected = [
      opts.full && "full",
      opts.api && "api",
      opts.cli && "cli",
    ].filter(Boolean) as AgentGuideVariant[];

    if (selected.length > 1) {
      out.error({
        code: "conflicting_options",
        message: "Use only one of --full, --api, or --cli.",
      });
      return;
    }

    if (opts.list) {
      listAgents(out, globalOpts.json);
      return;
    }

    if (opts.install || opts.agent || opts.mcp) {
      const agents = opts.agent as string[] | undefined;
      let report: InstallReport;
      let mcp: McpRun<McpAddStatus> | undefined;
      try {
        report = installSkill({
          dir: typeof opts.install === "string" ? opts.install : undefined,
          agents,
        });
        if (opts.mcp) {
          if (!globalOpts.json) printInstallTable(report);
          out.spin("Registering the OpenDocs MCP server...");
          mcp = await addMcpServer({ agents });
          out.stopSpinner();
        }
      } catch (err) {
        out.error(err as { code?: string; message: string });
        return;
      }

      if (report.skipped.some((s) => s.reason === "write_failed") || mcp?.results.some((r) => r.status === "failed")) {
        process.exitCode = 1;
      }
      if (globalOpts.json) {
        out.result({
          installed: report.installed,
          skipped: report.skipped,
          version: CLI_VERSION,
          ...(mcp ? { mcp } : {}),
        });
      } else if (mcp) {
        process.stdout.write("\n");
        printMcpResults(mcp, "add");
      } else {
        printInstallTable(report);
      }
      return;
    }

    const variant = selected[0] ?? "concise";

    try {
      const content = getAgentGuide(variant);
      if (globalOpts.json) {
        out.result({ variant, version: CLI_VERSION, content });
        return;
      }
      process.stdout.write(ensureTrailingNewline(content));
    } catch (err) {
      out.error(err as { code?: string; message: string });
    }
  });

interface InstalledEntry {
  agent: string;
  path: string;
  status: InstallStatus;
}

interface SkippedEntry {
  agent: string;
  reason: "not_detected" | "symlink" | "not_a_folder" | "write_failed";
  path?: string;
  message?: string;
  linkTarget?: string;
}

interface InstallReport {
  installed: InstalledEntry[];
  skipped: SkippedEntry[];
  names: Map<string, string>;
}

function installSkill(opts: { dir?: string; agents?: string[] }): InstallReport {
  if (opts.dir && opts.agents) {
    throw {
      code: "conflicting_options",
      message: "Use either --install <dir> or --agent <ids...>, not both.",
    };
  }
  const files = bundledSkillFiles();

  // A folder the user named: it is the skill folder itself, as before.
  if (opts.dir) {
    const dir = path.resolve(opts.dir);
    const outcome = installSkillFolder(dir, files, { followDirSymlink: true });
    if (!outcome.ok) throw { code: outcome.reason, message: outcome.message };
    return {
      installed: [{ agent: "custom", path: dir, status: outcome.status }],
      skipped: [],
      names: new Map([["custom", "Folder"]]),
    };
  }

  const all = resolveAgents();
  const names = new Map(all.map((a) => [a.id, a.name]));
  const skipped: SkippedEntry[] = [];
  let targets: SkillAgent[];

  if (opts.agents) {
    const wanted = new Set<string>();
    for (const raw of opts.agents.flatMap((v) => v.split(",")).filter((v) => v.trim())) {
      const id = normalizeAgentId(raw);
      if (!id) {
        throw {
          code: "unknown_agent",
          message: `Unknown agent "${raw.trim()}". Supported: ${AGENT_IDS.join(", ")}.`,
        };
      }
      wanted.add(id);
    }
    targets = all.filter((a) => wanted.has(a.id));
  } else {
    targets = [];
    for (const agent of all) {
      if (isAgentDetected(agent)) targets.push(agent);
      else skipped.push({ agent: agent.id, reason: "not_detected" });
    }
  }

  // Agents that share a skills folder (directly, or through a symlinked
  // skills folder) get one write and the same status.
  const outcomes = new Map<string, InstallOutcome>();
  const installed: InstalledEntry[] = [];
  const installedReal = new Set<string>();
  for (const agent of targets) {
    const dest = path.join(agent.skillsDir, SKILL_NAME);
    const key = path.join(realTarget(agent.skillsDir), SKILL_NAME);
    let outcome = outcomes.get(key);
    if (!outcome) {
      outcome = installSkillFolder(dest, files);
      outcomes.set(key, outcome);
    }
    if (outcome.ok) {
      installed.push({ agent: agent.id, path: dest, status: outcome.status });
      installedReal.add(key);
    } else {
      skipped.push({
        agent: agent.id,
        reason: outcome.reason,
        path: dest,
        message: outcome.message,
        ...(outcome.linkTarget ? { linkTarget: outcome.linkTarget } : {}),
      });
    }
  }

  // A symlinked skill folder that points at a folder this run installed is
  // still up to date; say so instead of leaving it looking broken.
  for (const entry of skipped) {
    if (entry.reason !== "symlink" || !entry.path || !entry.linkTarget) continue;
    if (installedReal.has(realTarget(entry.path))) {
      entry.message = `${entry.path} is a symlink to ${entry.linkTarget}, installed above; left as is`;
    }
  }

  return { installed, skipped, names };
}

function printInstallTable({ installed, skipped, names }: InstallReport): void {
  const lines: string[] = [];
  if (installed.length > 0) {
    lines.push(`OpenDocs skill ${CLI_VERSION}`, "");
    const rows = installed.map((e) => [names.get(e.agent) ?? e.agent, tildify(e.path), e.status]);
    for (const row of formatColumns(rows)) lines.push(`  ${row}`);
  } else {
    lines.push(
      "No supported agents found.",
      `Install for one anyway with ${brand.purple("opendocs agent --install --agent <id>")} (ids: ${brand.purple("opendocs agent --list")}),`,
      `or into a folder of your choice with ${brand.purple("opendocs agent --install <dir>")}.`,
    );
  }

  const problems = skipped.filter((s) => s.reason !== "not_detected");
  const notFound = skipped.filter((s) => s.reason === "not_detected");
  if (problems.length > 0) {
    lines.push("");
    for (const s of problems) {
      lines.push(`  ${brand.warn("Skipped")} ${names.get(s.agent) ?? s.agent}: ${tildifyText(s.message ?? s.reason)}`);
    }
  }
  if (notFound.length > 0 && installed.length > 0) {
    lines.push("", brand.muted(`  Not found: ${notFound.map((s) => names.get(s.agent) ?? s.agent).join(", ")}`));
  }
  if (installed.some((e) => e.status !== "unchanged")) {
    lines.push("", "Restart your agents (or start a new session) to load the skill.");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function listAgents(out: Output, json: boolean): void {
  const agents = resolveAgents().map((a) => ({
    agent: a.id,
    name: a.name,
    path: path.join(a.skillsDir, SKILL_NAME),
    detected: isAgentDetected(a),
  }));
  if (json) {
    out.result({ agents, version: CLI_VERSION });
    return;
  }
  const rows = [
    ["Agent", "Id", "Skill folder", "Detected"],
    ...agents.map((a) => [a.name, a.agent, tildify(a.path), a.detected ? "yes" : "no"]),
  ];
  const lines = formatColumns(rows).map((row) => `  ${row}`);
  lines.push(
    "",
    `${brand.purple("opendocs agent --install")} installs for the detected agents; add ${brand.purple("--agent <id...>")} for others.`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

function bundledSkillFiles(): SkillFile[] {
  return [
    { path: "SKILL.md", content: ensureTrailingNewline(readBundledAgentFile("SKILL.md")) },
    {
      path: "scripts/opendocs.sh",
      content: readBundledAgentFile("scripts/opendocs.sh"),
      executable: true,
    },
  ];
}

function getAgentGuide(variant: AgentGuideVariant): string {
  switch (variant) {
    case "full":
      return readBundledAgentFile("SKILL.md");
    case "api":
      return API_GUIDE;
    case "cli":
      return CLI_GUIDE;
    case "concise":
      return CONCISE_GUIDE;
  }
}

function readBundledAgentFile(relative: string): string {
  for (const filePath of bundledAgentCandidates(relative)) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  }

  throw {
    code: "agent_guide_missing",
    message: `Bundled agent/${relative} was not found. Reinstall or update @opendocs.cc/cli.`,
  };
}

function bundledAgentCandidates(relative: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Built package: dist/index.js -> package root/agent/<file>
    path.resolve(here, "../agent", relative),
    // Source tests/dev: src/commands/agent.ts -> package root/agent/<file>
    path.resolve(here, "../../agent", relative),
  ];
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function wrapList(items: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (next.length > width && line) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
