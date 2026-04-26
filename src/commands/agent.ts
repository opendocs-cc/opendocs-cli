import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOutput } from "../lib/output.js";
import { CLI_VERSION } from "../lib/version.js";

type AgentGuideVariant = "concise" | "full" | "api" | "cli";

const CONCISE_GUIDE = `# OpenDocs Agent Guide

OpenDocs publishes Markdown to shareable URLs and can export those docs to PDF or DOCX.

## Agent defaults

- Use \`--json\` for commands you need to parse.
- Do not run bare \`opendocs login\` from an agent. Use \`opendocs login --key od_live_...\` or \`OPENDOCS_API_KEY=...\`.
- Confirm the active workspace/project with \`opendocs whoami --json\`. Switch workspace with \`opendocs workspace use <slug>\`; switch project with \`opendocs project use <slug>\`.
- Use projects for coherent doc batches tied to a repo, product, launch, client, or experiment. Default project is fine for one-off docs.
- Default visibility is \`workspace\`. Never use \`--visibility public --confirm-public\` unless the user explicitly asked for public sharing.
- Prefer one batch command over loops. \`opendocs publish ./folder --tags <tag> --json\` recursively uploads Markdown files and auto-chunks.

## Core commands

\`\`\`bash
opendocs publish doc.md --json
opendocs publish ./docs --tags project-docs --json
opendocs publish report.md --export pdf --json
opendocs update revised.md --post-id <id-or-slug> --json
opendocs list --json --limit 100
opendocs list --all --json --limit 100
opendocs list --tag project-docs --json
opendocs project list --json
opendocs project create "Repo docs" --slug repo-docs --use --json
opendocs project use repo-docs --json
opendocs publish ./docs --project repo-docs --tags project-docs --json
opendocs get <id-or-slug> --json
opendocs pull <id-or-slug> --stdout
opendocs pull --project --tag project-docs --output ./docs --json
opendocs pull --workspace --output ./opendocs --json
opendocs export <id-or-slug> --format pdf
opendocs export a b c --format pdf
opendocs visibility <id-or-slug> public --confirm-public
opendocs unpublish <id-or-slug>
opendocs delete <id-or-slug> --yes
\`\`\`

## Limits to remember

- Markdown: 1 MB per document.
- Publish: 500 files per CLI invocation, auto-chunked into 25 docs per API request.
- Folder publish skips \`.obsidian\`, \`.trash\`, \`.git\`, \`.hg\`, and \`node_modules\`.
- Export: 10 posts per batch.
- Free plan: 10 published docs per workspace, PDF only, OpenDocs footer.
- Pro/Team: unlimited docs and DOCX export.

## Recovery

- \`document_limit\`: publish would exceed the Free cap. Ask the user to upgrade, unpublish old docs, or publish fewer files.
- \`too_many_files\`: split into multiple publish invocations.
- \`too_many_posts\`: split export into groups of 10.
- \`confirm_public_required\`: rerun with \`--confirm-public\` only after explicit user consent.
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
opendocs login --key od_live_xxxxx --json
opendocs whoami --json
opendocs workspace list --json
opendocs workspace use <slug> --json
\`\`\`

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

Flags: \`--title\`, \`--slug\` (single-file only), \`--visibility private|workspace|public\`, \`--confirm-public\`, \`--tags a,b\`, \`--project slug-or-id\`, \`--export pdf|docx\`.

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

\`update\` creates a new version and keeps the URL stable. It does not support \`--export\`; export separately after updating.

## Export and visibility

\`\`\`bash
opendocs export <id-or-slug> --format pdf
opendocs export a b c --format docx -o ./exports
opendocs visibility <id-or-slug> public --confirm-public
opendocs unpublish <id-or-slug>
opendocs delete <id-or-slug> --yes
\`\`\`

Batch export accepts up to 10 IDs/slugs and writes files locally from a zip manifest. \`delete --yes\` is required in non-interactive agent contexts.
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
