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

### `opendocs publish <file>`

Publish a Markdown file to OpenDocs.

```bash
opendocs publish guide.md
opendocs publish guide.md --title "Getting Started" --slug getting-started
opendocs publish guide.md --visibility public --confirm-public
opendocs publish guide.md --tags "tutorial,getting-started"
```

| Flag               | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `--title <title>`  | Override document title (defaults to first `# heading`) |
| `--slug <slug>`    | Custom URL slug                                         |
| `--visibility <v>` | `private`, `workspace` (default), or `public`           |
| `--tags <tags>`    | Comma-separated tags                                    |
| `--confirm-public` | Required when publishing as `public`                    |

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
