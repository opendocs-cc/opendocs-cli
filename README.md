# opendocs

CLI for publishing Markdown to [OpenDocs](https://opendocs.cc). Works great with AI agents like OpenClaw, Claude Code, Cursor, Copilot, and others.

## Install

```bash
npm install -g @opendocs.cc/cli
```

Or run directly with npx:

```bash
npx @opendocs.cc/cli <command>
```

## Quick start

```bash
# 1. Authenticate with your API key
opendocs login

# 2. Publish a Markdown file
opendocs publish README.md

# 3. List your documents
opendocs list
```

Get an API key from your [OpenDocs dashboard](https://opendocs.cc/dashboard/api-keys).

## For AI agents

Every command accepts `--json` for machine-readable output — stdout becomes a single parseable JSON object, errors are written as JSON to stderr, and human-readable spinners are suppressed. This is designed to let coding agents (Claude Code, Cursor, Copilot, OpenClaw, etc.) drive the CLI deterministically.

Two agent-friendly features worth knowing:

- **Batch publishing.** Pass multiple files to `opendocs publish` and the CLI uses the batch endpoint — one authenticated request handles up to 10 documents at a time, and larger invocations are auto-chunked. Never loop `opendocs publish` per file in a shell.
- **Publish + export in one step.** `opendocs publish doc.md --export pdf --json` publishes the doc *and* writes a branded PDF next to the source — one round trip, one command. Great for "turn these notes into a report" workflows.

See the error codes table in [Troubleshooting](#troubleshooting) for structured recovery hints.

## Commands

### `opendocs login`

Authenticate with your OpenDocs API key. The key is stored locally at `~/.config/opendocs/config.json`.

```bash
opendocs login
opendocs login --key od_live_abc123
```

The interactive prompt hides the key while you type. For scripts, prefer
`OPENDOCS_API_KEY` over `--key` so the key is less likely to land in shell
history.

### `opendocs logout`

Clear stored credentials.

```bash
opendocs logout
```

### `opendocs whoami`

Show current authentication status, username, and workspace.

```bash
opendocs whoami
```

### `opendocs publish <files...>`

Publish one or more Markdown files to OpenDocs. Pass multiple files (or a glob) and the CLI uses the batch endpoint — one authenticated request handles up to 10 documents at a time, and larger invocations are auto-chunked.

```bash
# Single file
opendocs publish guide.md
opendocs publish guide.md --title "Getting Started" --slug getting-started
opendocs publish guide.md --visibility public --confirm-public
opendocs publish guide.md --tags "tutorial,getting-started"

# Multiple files (auto-batched, up to 100 per invocation)
opendocs publish doc1.md doc2.md doc3.md
opendocs publish docs/*.md --tags "release-2026-q2"

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
| `--confirm-public` | Required when publishing as `public`                                |
| `--export <fmt>`   | After publishing, export each doc to `docx` or `pdf` next to source |

**Limits:** 1 MB markdown per document, 100 files per invocation (auto-batched in groups of 10). Partial success is reported per-file — if one document's slug is taken, the others still publish.

**Local images:** Markdown and HTML image references that point to files next
to the source document are uploaded automatically before publish. Supported
formats are JPEG, PNG, WebP, GIF, and SVG, with a 10 MB cap per image and 30
local images per document. The CLI will not read images outside the directory
containing the Markdown file.

**`--export` behaviour:** PDFs/DOCX files are written next to each source (e.g. `docs/intro.md` → `docs/intro.pdf`). Publish and export phases are independent — if publish succeeds and export fails, posts stay up and the CLI prints a `opendocs export <postId> --format <fmt>` retry hint.

### Referencing a post: ID or slug

Every command that takes a `<postId>` also accepts the post's **slug** — the human-readable path segment from the URL (`opendocs.cc/<workspace>/<slug>`). Slugs are unique within your workspace, so there's no ambiguity. Use whichever is handier:

```bash
opendocs get my-guide              # slug — what you'd naturally type
opendocs get abc123                # UUID from `opendocs list --json`
```

This applies to `get`, `pull`, `unpublish`, `export`, and the `--post-id` flag on `update`.

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
| `--visibility <v>`     | Change visibility (`private`, `workspace`, `public`) |
| `--tags <tags>`        | Replace tags (comma-separated)                       |
| `--confirm-public`     | Required when changing to `public`                   |

Like `publish`, `update` uploads supported local image references from the
Markdown file's directory before sending the new version.

### `opendocs unpublish <id|slug>`

Unpublish a document (keeps the content, removes public access).

```bash
opendocs unpublish my-guide
```

### `opendocs list` (alias: `opendocs ls`)

List your documents with pagination. `opendocs ls` is a muscle-memory alias for anyone used to `ls`.

```bash
opendocs list
opendocs ls                              # same thing
opendocs list --page 2 --limit 50
opendocs list --tag tutorial
```

| Flag          | Description                               |
| ------------- | ----------------------------------------- |
| `--page <n>`  | Page number (default: `1`)                |
| `--limit <n>` | Results per page, max 100 (default: `20`) |
| `--tag <tag>` | Filter by tag                             |

`--page` and `--limit` must be positive integers; `--limit` cannot exceed 100.

### `opendocs get <id|slug>`

Get details of a specific document.

```bash
opendocs get my-guide
```

### `opendocs pull <id|slug>`

Download the raw Markdown of a document.

```bash
opendocs pull my-guide                    # Saves to <slug>.md
opendocs pull my-guide -o current.md      # Custom output path
opendocs pull my-guide --stdout           # Print to stdout
```

| Flag                  | Description                       |
| --------------------- | --------------------------------- |
| `-o, --output <path>` | Output file path                  |
| `--stdout`            | Print to stdout instead of saving |

### `opendocs export <idsOrSlugs...>`

Export one or more published documents as formatted `.docx` or `.pdf` files. Pass multiple IDs or slugs to export a batch (delivered as a zip and unpacked locally).

```bash
# Single
opendocs export my-guide --format pdf                    # Saves to my-guide.pdf
opendocs export my-guide --format docx                   # Saves to my-guide.docx
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
| `-f, --format <format>` | `docx` (default) or `pdf`                                    |
| `-o, --output <path>`   | File path (single doc) or directory (multiple docs)          |
| `--stdout`              | Write binary to stdout (single doc only)                     |
| `--landscape`           | Render in landscape A4                                       |
| `--accent-color <hex>`  | Brand accent hex (e.g. `#B91C1C`) — derives the full palette |

**Batch mode:** pass up to 10 IDs or slugs in one call. The server runs each conversion sequentially and returns a single zip containing all outputs plus a `manifest.json` with per-doc results. The CLI unpacks into the target directory (cwd by default) and prints one success/failure line per doc. Partial success is supported — if one doc fails (e.g. converter error), the rest still land.

Output filenames returned by the API are treated as basenames only; unsafe
filenames containing path separators are rejected instead of being written
outside the requested output directory.

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
| `doc_too_large`         | File exceeds the 1 MB markdown cap.                                 | Split the document — this is a hard server-side limit.                      |
| `too_many_files`        | >100 files passed in one `publish` invocation.                      | Split into multiple runs.                                                   |
| `too_many_posts`        | >10 postIds passed to `export`.                                     | Export in groups of 10.                                                     |
| `invalid_format`        | `--format` / `--export` wasn't `pdf` or `docx`.                     | Fix the flag value.                                                         |
| `invalid_page`          | `--page` was not a positive integer.                                | Use `--page 1` or another positive integer.                                 |
| `invalid_limit`         | `--limit` was not a positive integer between 1 and 100.             | Pick a limit from 1 to 100.                                                  |
| `conflicting_options`   | Flags don't combine (e.g. `--title` with multiple files).           | Drop the conflicting flag.                                                  |
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

## License

MIT
