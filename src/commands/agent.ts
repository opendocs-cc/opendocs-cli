import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOutput } from "../lib/output.js";
import { CLI_VERSION } from "../lib/version.js";

type AgentGuideVariant = "concise" | "full" | "api" | "cli";

const CONCISE_GUIDE = `# OpenDocs Agent Guide

OpenDocs publishes Markdown to shareable URLs and can export those docs to PDF or DOCX.

## Getting started (no browser needed)

1. Check \`opendocs whoami --json\`. If it says not logged in, ask the user for their email address.
2. Run \`opendocs login --email <email> --json\`. It emails a 6-digit code and exits (\`status: "code_sent"\`).
3. Ask the user: "Check your inbox for a code from OpenDocs and paste it here."
4. Run \`opendocs login --email <email> --code <code> --json\`. New emails get an account, a workspace and an API key automatically; the key is saved for you. Never ask the user to copy keys around.

No account yet and the user just wants a link? \`opendocs publish doc.md --anonymous --json\` gives a link anyone can open for 24 hours plus a claim URL. Tell the user it expires; logging in later from the same folder claims it automatically.

## Agent defaults

- Use \`--json\` for commands you need to parse. Errors carry \`error\`, \`message\` and \`docs_url\`.
- Re-publishing a file this folder already published updates the same document (tracked in \`.opendocs/state.json\`) — don't use \`update\` or worry about duplicates. Use \`--new\` only to deliberately create a copy.
- A \`version_conflict\` means someone else published a newer version. Show the user, then pull it or re-run with \`--force\` only if they agree.
- Default visibility is \`workspace\`. Never use \`--visibility public --confirm-public\` unless the user explicitly asked for public sharing.
- To share with someone outside the workspace, use \`opendocs share <doc> <email>\` instead of making it public.
- Prefer one batch command over loops. \`opendocs publish ./folder --tags <tag> --json\` recursively uploads Markdown files and auto-chunks.
- \`--project "Name"\` creates the project the first time.

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
opendocs invite dana@acme.com --json
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
- Free plan: 10 published docs per workspace, PDF only, OpenDocs footer.
- Pro/Team: unlimited docs and DOCX export.

## Recovery

- \`not_logged_in\`: follow "Getting started" above, or publish \`--anonymous\` if the user agrees to a public 24-hour link.
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
opendocs invite sam@acme.com [--role admin] --json
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

Limits: 1 MB Markdown per doc, 500 files per invocation, 25 docs per publish batch. Folder publish is recursive and skips \`.obsidian\`, \`.trash\`, \`.git\`, \`.hg\`, and \`node_modules\`.

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
`;

const API_GUIDE = `# OpenDocs Public API Agent Reference

Base URL: \`https://api.opendocs.cc\`

Auth: \`Authorization: Bearer od_live_...\`

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
| Unpublish | \`POST /api/v1/posts/:idOrSlug/unpublish?workspaceId=...\` | Reversible hide; frees Free-plan slot if published. |
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
  .description("Print OpenDocs instructions for AI agents")
  .option("--full", "Print the full bundled SKILL.md")
  .option("--api", "Print API-only reference")
  .option("--cli", "Print CLI-only reference")
  .option(
    "--install [dir]",
    "Install SKILL.md as an agent skill (default: ~/.claude/skills/opendocs)",
  )
  .action((opts, cmd) => {
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

    if (opts.install) {
      try {
        const dir =
          typeof opts.install === "string"
            ? path.resolve(opts.install)
            : path.join(os.homedir(), ".claude", "skills", "opendocs");
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, "SKILL.md");
        fs.writeFileSync(target, ensureTrailingNewline(readFullSkill()));
        if (!globalOpts.json) {
          process.stdout.write(`Installed the OpenDocs skill at ${target}\n`);
        }
        out.result({ installed: true, path: target, version: CLI_VERSION });
      } catch (err) {
        out.error(err as { code?: string; message: string });
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

function getAgentGuide(variant: AgentGuideVariant): string {
  switch (variant) {
    case "full":
      return readFullSkill();
    case "api":
      return API_GUIDE;
    case "cli":
      return CLI_GUIDE;
    case "concise":
      return CONCISE_GUIDE;
  }
}

function readFullSkill(): string {
  for (const filePath of fullSkillCandidates()) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  }

  throw {
    code: "agent_guide_missing",
    message:
      "Bundled SKILL.md was not found. Reinstall or update @opendocs.cc/cli.",
  };
}

function fullSkillCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Built package: dist/index.js -> package root/agent/SKILL.md
    path.resolve(here, "../agent/SKILL.md"),
    // Source tests/dev: src/commands/agent.ts -> package root/agent/SKILL.md
    path.resolve(here, "../../agent/SKILL.md"),
  ];
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
