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

## Commands

### `opendocs login`

Authenticate with your OpenDocs API key. The key is stored locally at `~/.config/opendocs/config.json`.

```bash
opendocs login
opendocs login --key od_live_abc123
```

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

**`--export` behaviour:** PDFs/DOCX files are written next to each source (e.g. `docs/intro.md` → `docs/intro.pdf`). Publish and export phases are independent — if publish succeeds and export fails, posts stay up and the CLI prints a `opendocs export <postId> --format <fmt>` retry hint.

### `opendocs update <file>`

Update an existing document with new content.

```bash
opendocs update guide.md --post-id abc123
opendocs update guide.md --post-id abc123 --visibility public --confirm-public
```

| Flag               | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `--post-id <id>`   | **(required)** ID of the post to update              |
| `--title <title>`  | Override document title                              |
| `--visibility <v>` | Change visibility (`private`, `workspace`, `public`) |
| `--tags <tags>`    | Replace tags (comma-separated)                       |
| `--confirm-public` | Required when changing to `public`                   |

### `opendocs unpublish <postId>`

Unpublish a document (keeps the content, removes public access).

```bash
opendocs unpublish abc123
```

### `opendocs list`

List your documents with pagination.

```bash
opendocs list
opendocs list --page 2 --limit 50
opendocs list --tag tutorial
```

| Flag          | Description                               |
| ------------- | ----------------------------------------- |
| `--page <n>`  | Page number (default: `1`)                |
| `--limit <n>` | Results per page, max 100 (default: `20`) |
| `--tag <tag>` | Filter by tag                             |

### `opendocs get <postId>`

Get details of a specific document.

```bash
opendocs get abc123
```

### `opendocs pull <postId>`

Download the raw Markdown of a document.

```bash
opendocs pull abc123                    # Saves to <slug>.md
opendocs pull abc123 -o my-doc.md       # Custom output path
opendocs pull abc123 --stdout           # Print to stdout
```

| Flag                  | Description                       |
| --------------------- | --------------------------------- |
| `-o, --output <path>` | Output file path                  |
| `--stdout`            | Print to stdout instead of saving |

### `opendocs export <postIds...>`

Export one or more published documents as formatted `.docx` or `.pdf` files. Pass multiple postIds to export a batch (delivered as a zip and unpacked locally).

```bash
# Single
opendocs export abc123 --format pdf                      # Saves to <slug>.pdf
opendocs export abc123 --format docx                     # Saves to <slug>.docx
opendocs export abc123 --format pdf -o report.pdf        # Custom output path
opendocs export abc123 --format pdf --landscape          # Landscape A4
opendocs export abc123 --format pdf --accent-color "#B91C1C"
opendocs export abc123 --format pdf --stdout | lp        # Pipe straight to lp

# Batch (up to 10 postIds per invocation)
opendocs export abc123 def456 ghi789 --format pdf        # Unpacks to cwd
opendocs export abc123 def456 --format pdf -o ./exports  # Unpacks to ./exports/
```

| Flag                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `-f, --format <format>` | `docx` (default) or `pdf`                                    |
| `-o, --output <path>`   | File path (single postId) or directory (multiple postIds)    |
| `--stdout`              | Write binary to stdout (single postId only)                  |
| `--landscape`           | Render in landscape A4                                       |
| `--accent-color <hex>`  | Brand accent hex (e.g. `#B91C1C`) — derives the full palette |

**Batch mode:** pass up to 10 postIds in one call. The server runs each conversion sequentially and returns a single zip containing all outputs plus a `manifest.json` with per-doc results. The CLI unpacks into the target directory (cwd by default) and prints one success/failure line per doc. Partial success is supported — if one doc fails (e.g. converter error), the rest still land.

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

Credentials are stored at `~/.config/opendocs/config.json` with `0600` permissions (readable only by you). The config file is created by `opendocs login` and removed by `opendocs logout`.

## License

MIT
