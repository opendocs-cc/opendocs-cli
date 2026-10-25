# opendocs

Publish Markdown to [OpenDocs](https://opendocs.cc) from your terminal or your AI agent: a shareable link your team can read, or a branded PDF or Word file. Works with Claude Code, Codex, Cursor, Copilot, OpenClaw and any agent that can run a command.

Full documentation: [docs.opendocs.cc](https://docs.opendocs.cc). Free for up to 50 documents.

## Install

```bash
npm install -g @opendocs.cc/cli
```

Requires Node.js 20 or newer.

Or run directly with npx:

```bash
npx @opendocs.cc/cli <command>
```

## Quick start

```bash
# 1. Sign up or sign in with an emailed code (no browser needed)
opendocs login --email you@example.com
opendocs login --email you@example.com --code 123456

# 2. Publish a Markdown file (publish it again later to update it)
opendocs publish README.md

# 3. List your documents
opendocs list
```

No account yet? `opendocs publish notes.md --anonymous` gives a link anyone can
open for 24 hours, plus a claim link to keep it. You can also use
`opendocs login --browser`, or `opendocs login --key od_live_xxxxx` with a key
from your [dashboard](https://opendocs.cc/dashboard/api-keys).

## For AI agents

Every command accepts `--json` for machine-readable output — stdout becomes a single parseable JSON object, errors are written as JSON to stderr, and human-readable spinners are suppressed. This is designed to let coding agents (Claude Code, Cursor, Copilot, OpenClaw, etc.) drive the CLI deterministically.

Agent-friendly features worth knowing:

- **Vault-friendly batch publishing.** Pass files or folders to `opendocs publish` and the CLI uses the batch endpoint — one authenticated request handles up to 25 documents at a time, and larger invocations are auto-chunked. Never loop `opendocs publish` per file in a shell.
- **Publish + export in one step.** `opendocs publish doc.md --export pdf --json` publishes the doc *and* writes a branded PDF next to the source — one round trip, one command. Great for "turn these notes into a report" workflows.
- **Bundled agent guide.** Run `opendocs agent` for a concise reference, `opendocs agent --cli` for CLI-only details, `opendocs agent --api` for API-only details, or `opendocs agent --full` for the full bundled `SKILL.md`. `opendocs agent --install` installs it as a skill for every agent on your machine (Claude Code, Codex, Cursor, Copilot, Gemini CLI, opencode and more).
- **MCP server for chat apps and tools.** OpenDocs also runs a remote MCP server at `https://mcp.opendocs.cc/mcp`. `opendocs mcp add` registers it in the coding tools on your machine and `opendocs mcp connect claude` (or `chatgpt`) adds it to the Claude or ChatGPT app. Each tool signs you in the first time; no API key is stored.
- **Folder sync without duplicates.** The CLI remembers what each folder published (`.opendocs/state.json`), so publishing a file again updates it. `opendocs clone`, `opendocs status` and `opendocs publish .` keep a folder in sync, and updates that would overwrite someone else's newer version stop with `version_conflict`.

New in 0.4:
- **Branded exports from the terminal:** `opendocs theme presets` lists curated color + font pairs; `opendocs theme set --preset boardroom` applies one (or `--color "#13294B" --font "IBM Plex Sans"`). `theme logo ./logo.png`, `theme footer --tagline ...` and `theme check <hex>` cover the rest. Brand colors must be dark enough for headings and white table-header text (4.5:1 on white); the API refuses lighter ones. Changes need `--yes` outside a terminal because they affect every export in the workspace.

New in 0.3:
- **Team from the terminal:** `opendocs team invite dana@acme.com` emails an invitation that Dana accepts. Invitees run `opendocs team join` (login tells them about pending invites). Also `team list | resend | revoke | role | remove | leave | decline` and domain auto-join with `team auto-join add acme.com`.
- **Projects like git branches:** `opendocs project link "Acme launch"` makes every new doc published from a folder land in that project, and `project list` shows each project's recent titles. `opendocs config set organize ask|auto|off` tells agents how proactively to sort documents into projects.

New in 0.2: `login --email`, `publish --anonymous`, `clone`, `status`, `history`, `rollback`, `move`, `share`, `invite`, `claim`, `workspace create`, `workspace members`, `list --project`, `export --project` and `pull --version`. Run `opendocs <command> --help` or see the [CLI reference](https://docs.opendocs.cc/cli/reference).

See the error codes table in [Troubleshooting](#troubleshooting) for structured recovery hints.

### `opendocs agent`

Print static, package-bundled instructions for AI agents. This command does not require login and does not fetch remote content.

```bash
opendocs agent          # concise, high-signal reference
opendocs agent --full   # full bundled SKILL.md
opendocs agent --api    # API-only reference
opendocs agent --cli    # CLI-only reference
```

With `--json`, the guide is wrapped as `{ "variant", "version", "content" }`.

#### Install the skill for your agents

```bash
opendocs agent --install                          # every agent found on this machine
opendocs agent --install --agent claude-code codex  # only these, even if not found
opendocs agent --list                             # supported agents, folders, detected or not
opendocs agent --install ./.claude/skills/opendocs  # a folder of your choice
opendocs agent --install --mcp                    # also register the MCP server (see below)
```

`--install` writes `SKILL.md` and `scripts/opendocs.sh` (the curl + jq client
for machines without Node.js) into each detected agent's global skills folder.
An agent counts as detected when its config folder exists. Agents that read
the shared `~/.agents/skills` folder share one copy there; the others get
their own:

| Agent | `--agent` id | Skill folder | Detected by |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/skills/opendocs` (`$CLAUDE_CONFIG_DIR`) | `~/.claude` |
| Codex | `codex` | `~/.agents/skills/opendocs` | `~/.codex` (`$CODEX_HOME`) |
| Cursor | `cursor` | `~/.agents/skills/opendocs` | `~/.cursor` |
| GitHub Copilot (CLI, VS Code) | `github-copilot` | `~/.agents/skills/opendocs` | `~/.copilot` (`$COPILOT_HOME`) |
| Gemini CLI | `gemini-cli` | `~/.agents/skills/opendocs` | `~/.gemini` |
| opencode | `opencode` | `~/.agents/skills/opendocs` | `~/.config/opencode` |
| Cline | `cline` | `~/.cline/skills/opendocs` | `~/.cline` |
| OpenClaw | `openclaw` | `~/.agents/skills/opendocs` (`$OPENCLAW_STATE_DIR/skills` if set) | `~/.openclaw` |
| Hermes Agent | `hermes-agent` | `~/.hermes/skills/opendocs` (`$HERMES_HOME`; `%LOCALAPPDATA%\hermes` on Windows) | `~/.hermes` |
| Windsurf | `windsurf` | `~/.agents/skills/opendocs` | `~/.codeium/windsurf` |
| Amp | `amp` | `~/.agents/skills/opendocs` | `~/.config/amp` |
| Goose | `goose` | `~/.agents/skills/opendocs` | `~/.config/goose` (`%APPDATA%\Block\goose` on Windows) |
| Kiro (IDE and CLI) | `kiro-cli` | `~/.kiro/skills/opendocs` (`$KIRO_HOME`) | `~/.kiro` |
| Grok Build | `grok` | `~/.agents/skills/opendocs` | `~/.grok` (`$GROK_HOME`) |

On Windows `~` is your user profile folder. The install only writes inside
`<skills folder>/opendocs/` and never deletes anything. A skill folder that is
a symlink (for example one `npx skills add` linked to `~/.agents/skills`) is
left alone and reported. Running it again only rewrites files that changed, so
it doubles as an update after `npm install -g @opendocs.cc/cli@latest`.

With `--json`: `{ "installed": [{ "agent", "path", "status" }], "skipped":
[{ "agent", "reason" }], "version" }`, where `status` is `installed`,
`updated` or `unchanged` and `reason` is `not_detected`, `symlink`,
`not_a_folder` or `write_failed`. `--list --json` returns
`{ "agents": [{ "agent", "name", "path", "detected" }], "version" }`.
With `--mcp`, the JSON also has `mcp` (the `opendocs mcp add` output below).

### `opendocs mcp`

OpenDocs runs a remote MCP server at `https://mcp.opendocs.cc/mcp`
([guide](https://opendocs.cc/mcp)). Each app or tool signs you in to OpenDocs
with OAuth the first time it uses it, so no API key is written into any
config.

```bash
opendocs mcp url                        # print the server URL
opendocs mcp add                        # register it in every coding tool found
opendocs mcp add --agent cursor codex   # only these, even if not found
opendocs mcp add --dry-run              # show what would change, change nothing
opendocs mcp remove                     # take it out again
opendocs mcp connect claude             # open Claude's "Add custom connector", prefilled
opendocs mcp connect chatgpt            # open ChatGPT's plugins page ("+" → "Add custom MCP server")
```

`mcp add` uses the same agent detection as `agent --install` (VS Code's and
Zed's settings folders count too). For each tool it uses the tool's own CLI
when it's on your PATH, otherwise it merges the server into the tool's MCP
config:

| Tool | `--agent` id | How |
| --- | --- | --- |
| Claude Code | `claude-code` | `claude mcp add --transport http --scope user opendocs <url>` (without `claude` on PATH it prints the command) |
| Codex | `codex` | appends `[mcp_servers.opendocs]` to `~/.codex/config.toml` (`$CODEX_HOME`); sign in with `codex mcp login opendocs` |
| Cursor | `cursor` | `~/.cursor/mcp.json` → `mcpServers.opendocs.url` |
| VS Code (GitHub Copilot) | `github-copilot` | `code --add-mcp ...`, or the user `mcp.json` (`~/Library/Application Support/Code/User`, `~/.config/Code/User`, `%APPDATA%\Code\User`) |
| Windsurf / Devin Desktop | `windsurf` | `~/.codeium/windsurf/mcp_config.json` and, if it exists, `~/.config/devin/mcp_config.json` → `serverUrl` |
| Gemini CLI / Antigravity | `gemini-cli` | `~/.gemini/config/mcp_config.json` (`serverUrl`) when `~/.gemini/config` exists, else `~/.gemini/settings.json` (`httpUrl`) |
| opencode | `opencode` | `~/.config/opencode/opencode.json` (`$XDG_CONFIG_HOME`) → `mcp.opendocs = { type: "remote", url, enabled: true }` |
| Kiro | `kiro-cli` | `~/.kiro/settings/mcp.json` (`$KIRO_HOME`) → `mcpServers.opendocs.url` |
| Cline, Amp, Goose, OpenClaw, Hermes Agent, Grok Build, Zed | `cline`, `amp`, `goose`, `openclaw`, `hermes-agent`, `grok`, `zed` | nothing is written; you get a one-line instruction |

Config files are only changed when they parse as plain JSON: a file with
comments or trailing commas, or one that is a symlink, is left alone and you
get the line to add yourself (status `manual`). The first change to an
existing file saves a copy next to it as `<file>.opendocs-backup`, and files
are replaced atomically. Re-running is safe: a server that's already there
with the same URL is reported as `already_present`, one with another URL is
updated.

With `--json`:

```json
{
  "url": "https://mcp.opendocs.cc/mcp",
  "results": [
    { "agent": "claude-code", "name": "Claude Code", "status": "added", "method": "cli",
      "command": "claude mcp add --transport http --scope user opendocs https://mcp.opendocs.cc/mcp" },
    { "agent": "cursor", "name": "Cursor", "status": "already_present", "method": "config",
      "path": "/Users/you/.cursor/mcp.json" },
    { "agent": "cline", "name": "Cline", "status": "manual", "method": "config",
      "message": "In Cline's MCP Servers panel, add a remote server \"opendocs\" with URL https://mcp.opendocs.cc/mcp." }
  ],
  "notDetected": ["gemini-cli", "opencode"]
}
```

`status` is `added`, `updated`, `already_present`, `manual`, `skipped` or
`failed` (`remove`: `removed`, `not_present`, `manual`, `skipped`, `failed`);
`--dry-run` adds `"dryRun": true`. The command exits 1 only if something
`failed`. `mcp url --json` prints `{ "url", "name", "displayName" }`, and
`mcp connect <app> --json` prints `{ "app", "openUrl", "url", "copied" }`
without opening a browser (it still copies the URL to the clipboard).

## Commands

### `opendocs login`

Authenticate with OpenDocs. The resulting API key is stored locally at
`~/.config/opendocs/config.json`.

```bash
opendocs login --email you@example.com            # emails a 6-digit code
opendocs login --email you@example.com --code 123456
opendocs login --browser
opendocs login
opendocs login --key od_live_abc123
```

`--email` signs in existing accounts and creates new ones (account, workspace
and an API key named after your agent). Without `--code` in a non-interactive
shell it sends the code and prints the exact command to finish.

`opendocs login --browser` opens OpenDocs in your browser. If you are already
signed in, you only need to confirm the visible account and workspace before
the CLI creates a new API key. Use the API-key prompt or `--key` for headless
scripts.

The interactive prompt hides the key while you type. For scripts, prefer
`OPENDOCS_API_KEY` over `--key` so the key is less likely to land in shell
history.

### `opendocs logout`

Clear stored credentials.

```bash
opendocs logout
```

### `opendocs whoami`

Show current authentication status, username, workspace, active project, and API URL.

```bash
opendocs whoami
```

The active project is where `publish`, `list`, and slug-based post commands act
by default.

### `opendocs project`

List, create, switch, rename, and delete projects in the active workspace.
Projects are useful when an agent publishes a batch of related documents and you
want that set isolated from the Default project.

```bash
opendocs project list
opendocs project current
opendocs project create "Launch docs" --slug launch-docs --use
opendocs project use launch-docs
opendocs project rename launch-docs --name "Launch documentation"
opendocs project delete launch-docs --yes
```

Default project documents use URLs like `opendocs.cc/<workspace>/<slug>`.
Non-default project documents use
`opendocs.cc/<workspace>/projects/<project>/<slug>`.

### `opendocs publish <files...>`

Publish one or more Markdown files to OpenDocs. Pass multiple files, globs, or folders and the CLI uses the batch endpoint — one authenticated request handles up to 25 documents at a time, and larger invocations are auto-chunked.

```bash
# Single file
opendocs publish guide.md
opendocs publish guide.md --title "Getting Started" --slug getting-started
opendocs publish guide.md --visibility public --confirm-public
opendocs publish guide.md --tags "tutorial,getting-started"
opendocs publish guide.md --project launch-docs

# Multiple files (auto-batched, up to 500 per invocation)
opendocs publish doc1.md doc2.md doc3.md
opendocs publish docs/*.md --tags "release-2026-q2"

# Folder / Obsidian vault upload (recursive; skips .obsidian, .trash, .git, .hg, .opendocs, node_modules)
opendocs publish ./vault --tags "obsidian-import"

# Publish and export in one command — PDFs land next to each source
opendocs publish docs/*.md --export pdf
opendocs publish guide.md --export docx
```

| Flag               | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `--title <title>`  | Override document title (single-file only)                          |
| `--slug <slug>`    | Custom URL slug (single-file only)                                  |
| `--visibility <v>` | `private`, `workspace` (default), or `public`                       |
| `--tags <tags>`    | Comma-separated tags (applied to every file when publishing multiple) |
| `--project <slugOrId>` | Publish to a specific project instead of the active project        |
| `--confirm-public` | Required when publishing as `public`                                |
| `--export <fmt>`   | After publishing, export each doc to `docx` or `pdf` next to source |

**Limits:** 1 MB markdown per document, 500 files per invocation (auto-batched in groups of 25). Partial success is reported per-file — if one document's slug is taken, the others still publish.

**Local images:** Markdown and HTML image references that point to files next
to the source document are uploaded automatically before publish. Supported
formats are JPEG, PNG, WebP, GIF, and SVG, with a 10 MB cap per image and 30
local images per document. The CLI will not read images outside the directory
containing the Markdown file.

**`--export` behaviour:** PDFs/DOCX files are written next to each source (e.g. `docs/intro.md` → `docs/intro.pdf`). Re-running it on files that are already published updates the ones that changed and exports all of them, so `opendocs publish docs --export pdf` after a round of edits gives you a fresh PDF of every file. Publish and export phases are independent — if publish succeeds and export fails, posts stay up and the CLI prints a `opendocs export <postId> --format <fmt>` retry hint.

### Referencing a post: ID or slug

Every command that takes a `<postId>` also accepts the post's **slug** — the human-readable path segment from the URL. Slugs are unique within the active project. Use whichever is handier:

```bash
opendocs get my-guide              # slug — what you'd naturally type
opendocs get abc123                # UUID from `opendocs list --json`
```

This applies to `get`, `pull`, `visibility`, `unpublish`, `delete`, `export`, and the `--post-id` flag on `update`. If the same slug exists in another project, switch with `opendocs project use <slug>` or pass the UUID.

### `opendocs update <file>`

Update an existing document with new content.

```bash
opendocs update guide.md --post-id my-guide
opendocs update guide.md --post-id abc123 --visibility public --confirm-public
```

| Flag                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `--post-id <id\|slug>` | **(required)** Post ID (UUID) or slug                |
| `--title <title>`      | Override document title                              |
| `--visibility <v>`     | Change visibility (`private`, `workspace`, `public`); omit to keep current visibility |
| `--tags <tags>`        | Replace tags (comma-separated); omit to keep current tags |
| `--confirm-public`     | Required when changing to `public`                   |

Like `publish`, `update` uploads supported local image references from the
Markdown file's directory before sending the new version.

### `opendocs visibility <id|slug> <level>`

Change a document's visibility without uploading new Markdown or creating a new
version.

```bash
opendocs visibility my-guide private
opendocs visibility my-guide workspace
opendocs visibility my-guide public --confirm-public
```

| Level       | Description                                                   |
| ----------- | ------------------------------------------------------------- |
| `private`   | Only you can read the document                                |
| `workspace` | Workspace members can read it (default for new documents)     |
| `public`    | Anyone with the link can read it; requires `--confirm-public` |

### `opendocs unpublish <id|slug>`

Take a document offline. Its content, version history and slug stay on the server, and it stops counting toward the Free plan's document limit. It can't be republished: to bring it back, publish the file again as a new document (`opendocs publish <file> --new` if this folder published it before), which gets a new URL.

```bash
opendocs unpublish my-guide
```

### `opendocs delete <id|slug>`

Permanently delete a document and free its slug. This cannot be undone.

```bash
opendocs delete my-guide --yes
```

Use `--yes` (or `-y`) in scripts, CI, and agent workflows. Without it, the CLI
will ask a human to re-type the ID or slug in an interactive terminal, and will
refuse to delete in non-interactive contexts.

### `opendocs list` (alias: `opendocs ls`)

List your documents with pagination. `opendocs ls` is a muscle-memory alias for anyone used to `ls`. The list covers the active project; when other projects have documents, it ends with how many and how to see them (`--all-projects`, or `--project <slug>`).

```bash
opendocs list
opendocs ls                              # same thing
opendocs list --page 2 --limit 50
opendocs list --tag tutorial
opendocs list --all
opendocs list --all-projects
```

| Flag          | Description                               |
| ------------- | ----------------------------------------- |
| `--page <n>`  | Page number (default: `1`)                |
| `--limit <n>` | Results per page, max 100 (default: `20`) |
| `--tag <tag>` | Filter by tag                             |
| `--all`       | Show documents across every workspace     |
| `--all-projects` | Show every project in the active workspace |

`--page` and `--limit` must be positive integers; `--limit` cannot exceed 100.

### `opendocs get <id|slug>`

Get details of a specific document.

```bash
opendocs get my-guide
```

### `opendocs pull`

Download raw Markdown for one document, a project, or the active workspace.

```bash
opendocs pull my-guide                    # Saves to <slug>.md
opendocs pull my-guide -o current.md      # Custom output path
opendocs pull my-guide --stdout           # Print to stdout
opendocs pull --project                   # Pull every doc in the active project
opendocs pull --project launch            # Pull every doc in a named project
opendocs pull --workspace                 # Pull every project in the active workspace
opendocs pull --tag release -o ./docs     # Pull matching docs in the active project
opendocs pull --workspace --tag release   # Pull matching docs across all projects
```

For single-document pulls, `-o` is a file path. For project/workspace pulls,
`-o` is an output directory. Project pulls write files directly into that
directory. Workspace pulls write Default project docs at the root and
non-default projects under `projects/<project-slug>/`.

Bulk pulls refuse to overwrite existing files unless you pass `--overwrite`.
Use `--dry-run` to preview the files that would be written.

| Flag                  | Description                                      |
| --------------------- | ------------------------------------------------ |
| `-o, --output <path>` | Output file path, or output directory for bulk   |
| `--stdout`            | Print one document to stdout instead of saving   |
| `--project [ref]`     | Pull active project, or a project slug/id        |
| `--workspace`         | Pull every project in the active workspace       |
| `--tag <tag>`         | Filter bulk pulls by tag                         |
| `--overwrite`         | Replace existing files during bulk pulls         |
| `--dry-run`           | Preview a bulk pull without writing files        |

### `opendocs export <idsOrSlugs...>`

Export one or more published documents as formatted `.pdf` or `.docx` files (PDF by default; DOCX needs Pro or Team). Pass multiple IDs or slugs to export a batch (delivered as a zip and unpacked locally).

```bash
# Single
opendocs export my-guide                                 # Saves to my-guide.pdf (PDF is the default)
opendocs export my-guide --format docx                   # Saves to my-guide.docx (Pro and Team)
opendocs export my-guide --format pdf -o report.pdf      # Custom output path
opendocs export my-guide --format pdf --landscape        # Landscape A4
opendocs export my-guide --format pdf --accent-color "#B91C1C"
opendocs export my-guide --format pdf --stdout | lp      # Pipe straight to lp

# Batch (up to 10 docs per invocation — mix IDs and slugs freely)
opendocs export intro guide api-spec --format pdf        # Unpacks to cwd
opendocs export abc123 def456 --format pdf -o ./exports  # Unpacks to ./exports/
```

| Flag                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `-f, --format <format>` | `pdf` (default) or `docx` (Pro and Team)                     |
| `-o, --output <path>`   | File path (single doc) or directory (multiple docs)          |
| `--stdout`              | Write binary to stdout (single doc only)                     |
| `--landscape`           | Render in landscape A4                                       |
| `--accent-color <hex>`  | Brand accent hex (e.g. `#B91C1C`) — derives the full palette |

**Batch mode:** pass up to 10 IDs or slugs in one call. The server runs each conversion sequentially and returns a single zip containing all outputs plus a `manifest.json` with per-doc results. The CLI unpacks into the target directory (cwd by default) and prints one success/failure line per doc. Partial success is supported — if one doc fails (e.g. converter error), the rest still land.

Output filenames returned by the API are treated as basenames only; unsafe
filenames containing path separators are rejected instead of being written
outside the requested output directory.

### `opendocs theme`

The look of exported PDF and Word files for the active workspace (Pro and Team; owners and admins).

```bash
opendocs theme                                # current brand color, font, preset, logo, footer
opendocs theme presets                        # classic, boardroom, editorial, research, studio, field-guide, letterpress, terminal, launch
opendocs theme fonts                          # Arial, Inter, IBM Plex Sans, Lato, Roboto, Manrope, Merriweather, Vollkorn, EB Garamond, JetBrains Mono
opendocs theme check "#13294B"                # contrast against white, without changing anything
opendocs theme set --preset editorial --yes
opendocs theme set --color "#0B3D5C" --font Inter --logo-in-exports on --yes
opendocs theme logo ./logo.png --yes          # or --remove
opendocs theme footer --company "Fjord" --tagline "Data platform team" --link-url fjord.example --yes
```

### `opendocs workspace`

List and switch between workspaces you belong to. The CLI stores one active
workspace and one active project locally; publish, update, list, get, pull,
visibility, unpublish, delete, and export use that active workspace/project for
slug lookups.

```bash
opendocs workspace list
opendocs workspace ls
opendocs workspace use acme-docs
opendocs workspace switch acme-docs
```

Switching workspaces only changes local CLI config. It also resets the active
project to that workspace's Default project. It does not change the active
workspace in the web dashboard.

## Global flags

These flags work with any command:

| Flag              | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `--json`          | Output results as JSON (for scripting and AI agents) |
| `--api-url <url>` | Override the API base URL                            |
| `--version`       | Show version number                                  |
| `--help`          | Show help                                            |

## JSON mode

Pass `--json` to get machine-readable output. Human-friendly spinners and formatting are suppressed, and results are printed as JSON to stdout.

```bash
opendocs list --json
opendocs get abc123 --json
opendocs publish doc.md --json
```

This is designed for AI coding agents and scripts that need to parse the output.

## Environment variables

| Variable           | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `OPENDOCS_API_KEY` | API key (alternative to `opendocs login`)                  |
| `OPENDOCS_API_URL` | Override API base URL (default: `https://api.opendocs.cc`) |
| `OPENDOCS_WEB_URL` | Override web URL for `opendocs login --browser`            |
| `OPENDOCS_MCP_URL` | Override the MCP server URL used by `opendocs mcp`         |

## Configuration

Credentials are stored at `~/.config/opendocs/config.json` with `0600` permissions (readable only by you). The containing config directory is kept at `0700`. The config file is created by `opendocs login` and removed by `opendocs logout`.

## Troubleshooting

When a command fails, the CLI exits non-zero and prints a structured error. In `--json` mode the error object is written to **stderr** (not stdout) so scripts can parse it cleanly:

```json
{ "error": "slug_taken", "message": "That slug is already in use." }
```

Common error codes:

| Error                   | What it means                                                       | How to recover                                                              |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `auth_expired` (401)    | API key revoked or invalid. Config is auto-cleared.                 | Run `opendocs login` with a new key.                                        |
| `onboarding_incomplete` | Account exists but username/workspace aren't set.                   | Finish onboarding at [opendocs.cc](https://opendocs.cc).                    |
| `no_workspace`          | Local config is missing workspaceId (rare — config corruption).     | Run `opendocs login` to refresh it.                                         |
| `slug_taken` (409)      | Slug already used within the workspace.                             | Re-run without `--slug` (auto-generates) or pick a different one.           |
| `reserved_slug`         | Slug collides with an OpenDocs route word such as `tag` or `projects`. | Pick another slug, or omit `--slug` and let OpenDocs suffix it.             |
| `project_not_empty`     | Tried to delete a project that still contains documents.             | Delete or move the documents first.                                         |
| `doc_too_large`         | File exceeds the 1 MB markdown cap.                                 | Split the document — this is a hard server-side limit.                      |
| `too_many_files`        | >500 files passed in one `publish` invocation.                      | Split into multiple runs.                                                   |
| `too_many_posts`        | >10 postIds passed to `export`.                                     | Export in groups of 10.                                                     |
| `invalid_format`        | `--format` / `--export` wasn't `pdf` or `docx`.                     | Fix the flag value.                                                         |
| `invalid_page`          | `--page` was not a positive integer.                                | Use `--page 1` or another positive integer.                                 |
| `invalid_limit`         | `--limit` was not a positive integer between 1 and 100.             | Pick a limit from 1 to 100.                                                  |
| `conflicting_options`   | Flags don't combine (e.g. `--title` with multiple files).           | Drop the conflicting flag.                                                  |
| `confirm_public_required` | Public visibility was requested without `--confirm-public`.       | Re-run with `--confirm-public` only after explicit user consent.            |
| `confirm_required`      | A destructive command needs confirmation in a non-interactive context. | Re-run with `--yes` if deletion is intentional.                          |
| `document_limit`        | Publish would exceed the Free plan's document cap.                  | Unpublish old docs, publish fewer files, or upgrade.                        |
| `image_upload_failed`   | A local image referenced by Markdown could not be uploaded.          | Fix or remove the image reference and retry.                                |
| `not_a_member`          | Tried to switch to a workspace the account cannot access.           | Run `opendocs workspace list` and choose one of those slugs.                |
| `not_found` (404)       | postId doesn't exist or isn't yours.                                | Double-check with `opendocs list`.                                          |
| `export_failed` (502)   | Converter service transient failure.                                | Retry. If this happened during `publish --export`, the post is still up — re-run just the export with `opendocs export <postId> --format <fmt>`. |

If something else goes wrong, re-run with `--json` and inspect stderr — most error paths include both a machine-readable `error` code and a human-readable `message`.

## Development

Clone and install:

```bash
git clone https://github.com/opendocs-cc/opendocs-cli.git
cd opendocs-cli
npm install
```

Useful scripts:

```bash
npm run dev         # Run the CLI directly from src/ via tsx
npm run build       # Bundle to dist/ with tsup
npm test            # Run the vitest suite
npm run typecheck   # tsc --noEmit
```

Tests spawn the CLI as a real subprocess against an in-process mock API — no network and no global config is touched (config lives under a throwaway `XDG_CONFIG_HOME`). See `test/helpers/` for the harness.

## Contributing

Bug reports and pull requests are welcome. Open an [issue](https://github.com/opendocs-cc/opendocs-cli/issues) first for anything bigger than a small fix, and run `npm test` and `npm run typecheck` before sending a PR. Report security problems privately as described in [SECURITY.md](SECURITY.md).

The OpenDocs service (web app, API and converter) is closed source; this repository covers the CLI and the agent skill in [`agent/SKILL.md`](agent/SKILL.md). `agent/scripts/opendocs.sh` is a copy of the no-Node.js client served at `https://opendocs.cc/.well-known/agent-skills/opendocs/scripts/opendocs.sh`; update both together.

## License

[MIT](LICENSE)
