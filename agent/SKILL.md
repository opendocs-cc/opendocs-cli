---
name: opendocs
description: Publish Markdown files to shareable URLs and convert them to branded PDF or DOCX files using the OpenDocs CLI. Use this skill whenever the user wants to publish, share, or export Markdown — including asks like "turn this into a shareable link", "give me a PDF of these notes", "upload all the docs in this folder", "update the post I published", or "convert this .md to Word". Also use for managing published documents (listing, updating, unpublishing) and for any workflow where Markdown needs to become either a URL or a formatted document file.
---

<!-- SPDX-License-Identifier: MIT -->

# OpenDocs — Publish Markdown to Shareable URLs and PDF/DOCX

OpenDocs turns any Markdown file into a clean, readable URL — and, in the same flow, a branded PDF or Word document if the user wants a file they can share offline. You interact with it via the `opendocs` CLI.

## Quick Reference

```
opendocs login --browser                     # Human-friendly browser login
opendocs login --key od_live_xxxxx           # Agent/script-safe API-key login
opendocs publish doc.md                      # Publish one Markdown file → get a URL
opendocs publish *.md                        # Publish multiple files (auto-batched, up to 500)
opendocs publish ./vault --tags obsidian     # Publish a folder/vault recursively
opendocs publish *.md --export pdf           # Publish AND export — PDFs land next to each source
opendocs update doc.md --post-id <id|slug>   # Update an existing post (new version)
opendocs list                                # List docs in the active workspace (alias: `opendocs ls`)
opendocs list --all                          # List across every workspace you belong to
opendocs project create <name> --use         # Create/switch to a project for a related doc batch
opendocs project use <slug>                  # Switch active project
opendocs list --tag <tag>                    # Filter by tag (great for finding a batch)
opendocs get <id|slug>                       # View post details
opendocs pull <id|slug>                      # Download raw Markdown
opendocs pull --project                      # Download every doc in the active project
opendocs pull --workspace                    # Download every doc in the active workspace
opendocs export <id|slug> --format pdf       # Export a published post as PDF (or docx)
opendocs export a b c --format pdf           # Batch export up to 10 posts at once (UUIDs or slugs)
opendocs unpublish <id|slug>                 # Hide a post (reversible — content kept on server)
opendocs visibility <id|slug> <level>        # Change visibility without re-uploading Markdown
opendocs delete <id|slug> --yes              # Permanently delete a post (frees its slug + quota slot)
opendocs whoami                              # Show current user/workspace/project
opendocs workspace list                      # List every workspace you belong to (alias: `workspace ls`)
opendocs workspace use <slug>                # Switch the active workspace (alias: `workspace switch`)
opendocs agent                               # Print concise AI-agent instructions
opendocs agent --full                        # Print the full bundled SKILL.md
opendocs logout                              # Clear stored credentials
```

Every command accepts `--json` for machine-readable output and `--api-url <url>` to override the API endpoint. When running programmatically, always pass `--json` — stdout becomes a single parseable JSON object, errors go to stderr, and human-readable spinners are suppressed.

**Every command that takes a `<postId>` also accepts a slug.** The slug is the post's human-readable path segment in the URL and is unique within the active project. Prefer post slugs when the user names a doc in natural language: `opendocs get my-report` is friendlier than copying the UUID from `opendocs list --json`. Internally the API resolves slug → postId via an indexed lookup scoped to the active workspace/project and then does the same ownership check as the UUID path.

**Workspace slug vs username — they are different things.** The URL is built from the *workspace* slug, not the user's username. Default project docs use `opendocs.cc/<workspace>/<post>`. Non-default project docs use `opendocs.cc/<workspace>/projects/<project>/<post>`. The username still exists for attribution in the UI, but it doesn't appear in published URLs.

---

## Setup

### Check if the CLI is installed and authenticated

```bash
opendocs --version    # should print a version like 0.1.x
opendocs whoami       # shows username + workspace name (the URL slug lives in the JSON output)
```

`opendocs whoami --json` is the most useful diagnostic command for an agent — it returns the CLI's active workspace slug (for building post URLs) plus the account/workspace context and document quota in one call:

```json
{
  "userId": "...",
  "onboarding": { "username": "...", "workspace": { "id": "...", "name": "Acme Docs", "slug": "acme-docs" } },
  "quota": { "documents": { "plan": "free", "limit": 10, "used": 3, "remaining": 7 } }
}
```

For Pro/Team workspaces, `quota.documents.limit` and `remaining` are `null` (meaning unlimited). The publish endpoints still re-check quota against the explicit `workspaceId` in the request body, so a stale local config can't bypass server enforcement.

If the CLI is missing:

```bash
npm install -g @opendocs.cc/cli
```

If the user isn't logged in, they need an API key that starts with `od_live_`. To get one:

1. **Sign up** at [opendocs.cc/signup](https://opendocs.cc/signup) if they don't have an account yet.
2. Complete onboarding — they'll pick a **username** (for attribution), a **workspace name** (display label), and a **workspace slug** (the short URL handle that becomes the `<workspace>` segment in `opendocs.cc/<workspace>/<post>`).
3. Go to **Dashboard → API Keys** and create a new key.

Then log in. For humans at a terminal, browser login is usually easiest:

```bash
opendocs login --browser
```

If the browser is already signed in, OpenDocs shows an authorization screen
with the current account and workspace; the user should confirm those are
correct before approving.

For agents, CI, or other headless automation, use an API key instead:

```bash
opendocs login --key od_live_xxxxx
# Or pass it via env var for scripts / CI:
export OPENDOCS_API_KEY=od_live_xxxxx && opendocs login
```

**Never run `opendocs login` without `--key` or the env var when invoking from an agent.** If neither is set, the CLI falls back to an interactive `Enter your API key:` prompt on stdin and blocks waiting for input — your tool call will hang. Always pass the key explicitly. The same applies to `OPENDOCS_API_URL` for non-default endpoints (it overrides the built-in `https://api.opendocs.cc` default).

**If the user has never used OpenDocs before, always tell them to sign up first at opendocs.cc/signup.** They cannot get an API key without an account — sending them to `opendocs login` first creates a confusing dead-end.

---

## Working with multiple workspaces

A user can belong to more than one workspace — a personal free workspace plus a Team-plan workspace, multiple Team workspaces, or any mix. The CLI stores **one active workspace at a time** in `~/.config/opendocs/config.json`. `publish` and `update` act on that active workspace (URL prefix, quota, and all). `list` defaults to it too, with `--all` as the escape hatch when the user wants to see every workspace's posts at once. There is no per-invocation `--workspace` flag on mutating commands; the switch is configured once and persists until you change it.

## Working with projects

Each workspace has a Default project plus optional named projects. Use a project
whenever an agent is publishing a coherent batch of docs for a product, launch,
client, experiment, or repo. Default is best for one-off docs.

```bash
opendocs project list --json
opendocs project create "OpenClaw docs" --slug openclaw-docs --use --json
opendocs publish ./docs --json
opendocs project use default --json
```

`opendocs workspace use <slug>` resets the active project to that workspace's
Default project. `opendocs list` shows the active project by default;
`opendocs list --all-projects` shows every project in the active workspace.

### List every workspace you belong to

```bash
opendocs workspace list                # alias: `opendocs workspace ls`
opendocs workspace list --json
```

The active workspace is marked with a `✔`. Each row has a name, slug, role (`owner` / `admin` / `member`), and active indicator. In `--json` mode:

```json
{
  "workspaces": [
    { "id": "ws_123", "name": "Acme", "slug": "acme", "role": "owner" },
    { "id": "ws_456", "name": "Side Project", "slug": "side-project", "role": "member" }
  ],
  "activeSlug": "acme"
}
```

Ordered by join date (earliest first). Only active memberships are returned — pending invitations and disabled members don't show up.

### Switch the active workspace

```bash
opendocs workspace use acme-labs       # alias: `opendocs workspace switch`
```

After the switch, the next `opendocs publish` creates posts under `opendocs.cc/acme-labs/<post-slug>` and `opendocs whoami` reflects the new active workspace. In `--json` mode the response is `{ "success": true, "workspaceId": "...", "workspaceName": "...", "workspaceSlug": "..." }`.

**Switching is purely local — it only touches the CLI's config file.** No server-side state changes, nothing is synced, and the web dashboard's active workspace is independent. The server validates the `workspaceId` on every post mutation, so you can't "switch" into a workspace you aren't a member of — `workspace use <slug>` rejects unknown slugs up front with `not_a_member`.

### Notes for agents

- **`opendocs whoami --json` is the cheapest way to read the active workspace.** It returns `onboarding.workspace.slug` directly — no need to hit `workspace list` just to answer "which workspace will the next publish go to?".
- **`opendocs login` picks the first workspace by default.** If the user belongs to multiple, login prints a hint but doesn't prompt — it picks the one the user joined first. After login, run `opendocs workspace use <slug>` if a script needs a specific workspace.
- **Confirm the active workspace before publishing when the user names one.** If the user says "publish this to the Acme workspace", don't assume the current active one is Acme. Run `opendocs workspace list --json`, match on `slug` or `name`, and `opendocs workspace use <slug>` first — skip the switch if `activeSlug` already matches.
- **Single-workspace users see the same commands work.** `workspace list` returns one row; `workspace use <your-only-slug>` is a successful no-op. You don't need to branch on membership count.

---

## Public API quick reference

Prefer the CLI for local-file workflows because it handles auth config, folder walking, local image uploads, batching, SSE progress, and export file placement. Use the public API directly when building an integration, backend job, or custom agent tool.

**Auth:** send API keys as `Authorization: Bearer od_live_...`. Session-cookie routes exist for the dashboard, but agent/tool builders should stick to the API-key-compatible routes below.

| Task | Endpoint | Notes |
|---|---|---|
| Current user + quota | `GET /api/v1/me?workspaceId=ws_...` | Pass `workspaceId` for multi-workspace accounts so quota matches the workspace you're about to publish to. |
| List workspaces | `GET /api/v1/workspaces` | API-key compatible; used by `opendocs workspace list/use`. |
| Publish one doc | `POST /api/v1/publish` | Requires `markdown` and `workspaceId`; max 1 MB Markdown. |
| Publish many docs | `POST /api/v1/publish/batch` | Max 25 docs per request; JSON returns `207`, SSE streams `result` + `summary` events. |
| List posts | `GET /api/v1/posts?workspaceId=...&tag=...&page=1&limit=100` | Omit `workspaceId` to list across workspaces authored by the caller. |
| Get metadata / Markdown | `GET /api/v1/posts/:idOrSlug`, `GET /api/v1/posts/:idOrSlug/raw` | Slugs can be disambiguated with `?workspaceId=...`. |
| Update / unpublish / visibility / tags / delete | `POST /api/v1/posts/:idOrSlug/update`, `POST /api/v1/posts/:idOrSlug/unpublish`, `POST /api/v1/posts/:idOrSlug/visibility`, `PATCH /api/v1/posts/:idOrSlug/tags`, `DELETE /api/v1/posts/:idOrSlug` | Updates create a new version but keep the URL stable. |
| Export one / many | `POST /api/v1/posts/:idOrSlug/export/:format`, `POST /api/v1/posts/batch/export` | `format` is `pdf` or `docx`; batch export max is 10 and returns a zip + manifest. |

API `url` fields are relative paths like `/<workspace-slug>/<post-slug>`. Prepend `https://opendocs.cc` when showing a full URL to a user.

---

## Plans and limits

Workspaces are on one of three plans. The CLI (and the API) enforce per-plan caps server-side, so you can't sneak past them — and a couple of these caps are easy for an agent to hit without realising:

| Plan | Documents per workspace | Workspaces | Members/workspace | DOCX export | PDF footer |
|---|---|---|---|---|---|
| **Free** | **10** | 1 | 3 | ❌ PDF only | "Made with OpenDocs" |
| **Pro** ($8/mo) | Unlimited | 2 included, then $4/mo each | 5 | ✅ | None |
| **Team** ($4/user/mo, 3-seat min) | Unlimited | Unlimited | Unlimited | ✅ | None |

The cap that bites agents most often is the **Free document limit**. Before any batch publish, the CLI does a best-effort `/api/v1/me` quota pre-check and rejects early if the batch clearly won't fit:

```json
{
  "error": "document_limit",
  "message": "Cannot publish 5 files: your free plan has 1 slot left (10/10 used). Upgrade to Pro for unlimited documents, or unpublish existing docs first."
}
```

When this happens, the right move depends on what the user wants:

- **They want to upload everything** → tell them about the limit and suggest upgrading to Pro, or ask which docs they'd rather keep. Don't loop and retry — the cap won't change.
- **They want to publish just a few** → publish the first N (where N = remaining slots) and report which ones got skipped.
- **They have stale docs** → they can `opendocs list`, `opendocs unpublish` the ones they don't need, then re-run.

**DOCX export requires Pro or Team.** If the user is on Free and asks for a Word document, the export endpoint returns `403`. Suggest PDF instead, or upgrade.

**Free-plan PDFs include a "Made with OpenDocs" footer.** Worth flagging if the user is exporting a PDF they intend to send to a client and you can see they're on Free — they may want to upgrade before exporting rather than after.

The other caps (workspace count, member count) are mostly the user's problem, not the agent's — the CLI doesn't ever try to create a workspace or invite a member. If you do see `plan_limit` or `member_limit` come back from the API, point the user at the dashboard.

---

## The hero workflow: publish and export in one step

This is the pattern that makes OpenDocs uniquely useful for an agent. Pass `--export pdf` (or `--export docx`) to `opendocs publish` and you get both:

- A **shareable URL** on opendocs.cc, and
- A **branded PDF or DOCX file** on disk, right next to the source `.md`.

```bash
opendocs publish docs/report.md --export pdf --json
# Creates:
#   - A post at opendocs.cc/<workspace>/report
#   - A file at docs/report.pdf  (next to the source)
# Returns a single JSON blob with both the URL and the local file path.
```

**Use this whenever** the user says something like "publish this doc and send me a PDF", "turn these notes into a shareable report", or "upload and download as PDF". It's one HTTP round trip fewer than the two-step flow (`publish` → `export`) and the CLI handles the postId → file mapping for you.

If publish succeeds but export fails (the converter briefly unavailable, say), the posts stay up and the CLI prints a retry hint — `opendocs export <postId> --format pdf` — so the agent can re-run just the export phase.

---

## Publishing

### One file

```bash
opendocs publish my-document.md
```

The CLI reads the file, extracts the first `# Heading` as the title, and returns a shareable URL. In `--json` mode:

```json
{ "postId": "abc123", "slug": "my-document", "url": "opendocs.cc/<workspace>/my-document", "title": "My Document" }
```

The `url` field is built from the active workspace's slug (from `opendocs whoami --json`'s `onboarding.workspace.slug`) plus the new post slug.

**Flags:**

| Flag | Description |
|------|-------------|
| `--title <title>` | Override the document title (single-file only) |
| `--slug <slug>` | Custom post slug — `my-doc` → `opendocs.cc/<workspace>/my-doc` (single-file only) |
| `--visibility <v>` | `private`, `workspace` (default), or `public` |
| `--tags <tags>` | Comma-separated tags — `"tutorial,release-q2"` |
| `--confirm-public` | Required alongside `--visibility public` |
| `--export <fmt>` | Also export to `pdf` or `docx` after publishing |

### Many files at once

Pass more than one file, or pass a folder, and the CLI uses the batch endpoint — one authenticated request handles up to 25 documents at a time, and the CLI auto-chunks larger invocations into sequential batches.

```bash
opendocs publish doc1.md doc2.md doc3.md
opendocs publish docs/*.md                          # shell glob
opendocs publish ./vault --tags obsidian            # recursive folder/vault upload
opendocs publish docs/*.md --tags "release-q2"      # shared tag applies to every file
```

**Never loop `opendocs publish` once per file.** The batch endpoint is designed for exactly this case — it authenticates once, processes the docs sequentially server-side with per-doc partial-success reporting, and emits live per-doc progress. Looping in a shell round-trips the network and the config N times and is dramatically slower.

**Progress output (interactive mode):** doc-by-doc, streamed as each publish completes:

```
Publishing batch 1/2 (25 docs)...
✔ guide.md → opendocs.cc/acme-docs/guide  (1/30)
✔ intro.md → opendocs.cc/acme-docs/intro  (2/30)
✖ duplicate.md — slug already exists  (3/30)
...
29 of 30 published. 1 failed.
```

**Partial success is the norm, not an error.** If one doc fails, the other 29 still publish. The CLI prints `✖ <file> — <reason>` inline and continues. `--json` mode returns one merged object with `total`, `succeeded`, `failed`, and a `results` array covering every file. A completed batch with per-doc failures still exits 0; inspect `failed` / `results[].success` to decide what to retry. Non-zero exits are for pre-flight failures, auth/config errors, network failures, or an aborted batch.

**Limits:**

| Limit | Value | What happens if exceeded |
|---|---|---|
| Markdown size per document | **1 MB** (~500 pages of prose) | CLI fails pre-flight with `doc_too_large`; no network call made. |
| Files per invocation | **500** | CLI fails pre-flight with `too_many_files`. Split into multiple runs. |
| Docs per publish batch HTTP request | **25** | Handled transparently — auto-chunked with cumulative progress. |

When a folder is passed, the CLI recursively publishes `.md` files and skips `.obsidian`, `.trash`, `.git`, `.hg`, and `node_modules`.

`--title` and `--slug` do not work with multiple files — each doc gets its title from its first `# heading` and a slug from the title. `--visibility`, `--tags`, and `--confirm-public` apply to every doc in the invocation.

### Inline images are uploaded automatically

If your Markdown references a local image — `![alt](./img/diagram.png)` or `![alt](/abs/path.png)` — the CLI uploads it to OpenDocs storage *before* publishing the doc and rewrites the link to the resulting public URL. Agents don't need to upload images manually or pre-process the Markdown. Things to know:

- **Remote URLs are left alone.** `![alt](https://example.com/x.png)` passes through unchanged.
- **Image caps:** max 30 local image references per document, max 10 MB per image. Supported extensions are `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, and `.svg`.
- **If image storage isn't configured server-side** (some self-hosted setups), the CLI prints a one-time warning and publishes with the *original* refs intact — the doc goes up but images render broken. Not an error; just a warning.
- **If a specific image is missing, outside the document directory, too large, unsupported, or rejected during upload**, the CLI warns `Image skipped: <ref> — <reason>` and publishes with that original ref intact. The hard `image_upload_failed` error is reserved for failures that abort the image-upload phase as a whole.

### Update an existing document

```bash
opendocs list --json                              # find the post (or just recall the slug)
opendocs update revised.md --post-id my-report    # slug works — same effect as passing the UUID
opendocs update revised.md --post-id abc123       # or UUID from `opendocs list --json`
```

This creates a new version — the URL stays the same, previous versions are preserved server-side. Same flags as `publish` except:

- **`--slug` is not allowed** (slugs are immutable after first publish).
- **`--export` is not supported on `update`.** If the user wants the updated PDF/DOCX too, run a separate `opendocs export <slug> --format pdf` after the update succeeds. (The hero `--export` flow only exists on `publish`.)
- **`--visibility` has no default.** Omit it to preserve the post's current visibility. Pass it (with `--confirm-public` if going public) to change it.
- **`--post-id` is required** and accepts either the UUID or the slug.

---

## Exporting

OpenDocs renders Markdown into branded PDF or DOCX files server-side — not raw HTML-to-PDF. The output is a typeset document with custom fonts, accent colors, and consistent typography, meant for things a user would actually send to a client or print.

### One post

```bash
opendocs export my-report --format pdf     # by slug → writes my-report.pdf to cwd
opendocs export abc123 --format docx       # or by UUID — same result
```

**Flags:**

| Flag | Description |
|------|-------------|
| `-f, --format <format>` | `docx` (default) or `pdf` |
| `-o, --output <path>` | File path (single doc) or directory (multiple docs) |
| `--stdout` | Write binary to stdout — single doc only, useful for piping |
| `--landscape` | Landscape A4 (PDF only) |
| `--accent-color <hex>` | Hex color like `#B91C1C` — derives the full palette |

**Examples:**

```bash
opendocs export my-report --format pdf --accent-color "#14306E" -o report.pdf
opendocs export my-report --format pdf --stdout | lp             # pipe straight to a printer
```

### Batch (up to 10 docs)

Pass multiple IDs or slugs and the server converts them sequentially, returning a zip that the CLI unpacks locally:

```bash
opendocs export intro guide api-spec --format pdf                # by slug
opendocs export post1 post2 post3 --format pdf -o ./exports/     # or by UUID, unpacks into ./exports/
```

Much faster than N individual calls — one authenticated request, all conversions run back-to-back on the same server worker pool. **Use this after `opendocs list --tag <group>`** when the user wants every doc in a group as a bundle.

---

## Reading

### List, get, pull

```bash
opendocs list                                  # recent posts in the active workspace (alias: `opendocs ls`)
opendocs list --all                            # recent posts across every workspace you belong to
opendocs list --tag release-q2                 # filter by tag
opendocs list --page 2 --limit 50              # pagination
opendocs list --json --limit 100               # parse this in scripts

opendocs get my-report                         # by slug — no UUID copying needed
opendocs get abc123                            # or by UUID from `opendocs list --json`
opendocs pull my-report                        # download raw markdown → <slug>.md
opendocs pull my-report -o current.md          # explicit output path
opendocs pull my-report --stdout | head -20    # pipe to another tool
opendocs pull --project -o ./docs              # pull active project into a folder
opendocs pull --project launch --tag q2        # pull tagged docs from a named project
opendocs pull --workspace -o ./opendocs        # pull whole active workspace
opendocs pull --workspace --dry-run            # preview bulk writes
```

**`opendocs list` is scoped to the active workspace by default.** The CLI
passes the active `workspaceId` as a filter so you only see posts in the
workspace the next `publish` will go to. Use `--all` when you need every
post across every workspace the user belongs to — this is the right mode
for "show me everything I've ever published" style asks. Each post in the
response includes `workspaceId` and `workspaceSlug`, and the top-level
response has `scope: "workspace" | "all"` plus a `workspaceSlug` that's
the active slug in the default mode or `null` in `--all` mode.

**Bulk `opendocs pull` is scoped to the active project unless `--workspace`
or `--project <slug>` is passed.** It refuses to overwrite local files by
default; add `--overwrite` only when the user explicitly wants local Markdown
replaced. Workspace pulls put Default project docs at the output root and
non-default projects under `projects/<project-slug>/`.

### Unpublish (hide — reversible)

```bash
opendocs unpublish my-report     # by slug
opendocs unpublish abc123        # or by UUID
```

Flips the post's `isPublished` flag off. The row, slug reservation, and content all stick around — the post just stops being reachable at its URL. If the post was published, this frees a Free-plan document slot because the quota counts only `isPublished = true` posts. Re-publishing later goes through `opendocs publish` again; `opendocs update` only works on currently published posts.

### Change visibility without re-uploading

```bash
opendocs visibility my-report private                      # by slug
opendocs visibility abc123 workspace                       # or by UUID
opendocs visibility my-report public --confirm-public      # requires explicit flag
```

Levels: `private` (only you), `workspace` (default — workspace members), `public` (anyone with the link — workspace owner must also have enabled "Allow public documents"). This command flips the visibility bit directly — it does **not** create a new version, re-process images, or touch the Markdown. Use it when the user only wants to change who can see the post, not its content. For content changes, `opendocs update` is the right command (and it accepts `--visibility` too).

The CLI refuses `public` without `--confirm-public` as a guard — same rule as `publish`. If the user clearly asks for public, pass the flag; if they're ambiguous ("share this"), confirm first.

### Delete (permanent — irreversible)

```bash
opendocs delete my-report --yes    # required in scripts / agent invocations
opendocs delete abc123 --yes       # by UUID
opendocs delete my-report          # interactive — prompts for slug confirmation in a terminal
```

Hard-deletes the post. Removes the row, every version, all tags, and frees the slug for reuse. Audited server-side. **Cannot be undone** — there's no recycle bin, no soft-delete retention window. The post's URL becomes 404, and its quota slot returns to the workspace's `quota.documents.remaining`.

**Always pass `--yes` (or `-y`) from an agent.** Without it, the CLI refuses to fire in any non-TTY context (scripts, pipes, agent tool calls) and exits with `confirm_required` — this is the primary safety rail. Humans at a real terminal without `--yes` get an interactive "type the slug to confirm" prompt; hitting enter on anything else cancels cleanly.

**Unpublish vs delete at a glance:**

| Concern | `unpublish` | `delete` |
|---|---|---|
| Reversible? | Yes — just `update` or re-`publish` | **No** |
| Keeps the slug reservation? | Yes — same slug can't be claimed by anyone else | No — frees the slug |
| Frees a quota slot? | Yes, if the post was published | Yes, if the post was published |
| Preserves version history? | Yes | No — every version is wiped |
| Right tool for… | "Hide this draft for now" / "take it down temporarily" | "I'm done with this, remove it / free the slot" |

When the user says "remove this post" without qualification, **prefer `unpublish`** — it's reversible. Only use `delete` when they clearly want the content gone for good, or they need to free a slot on the Free plan and have no older posts worth keeping.

---

## Tags

Tags are plain string labels. They're the primary way to group related posts so the user (or the agent) can find them again as a set.

```bash
opendocs publish doc.md --tags "tutorial,getting-started"
opendocs publish ./docs --tags "release-q2"      # recursive folder upload
opendocs list --tag release-q2                   # retrieve the group
```

**Limits:** max 20 tags per document, max 64 chars per tag, comma-separated at the CLI.

**When publishing a batch of related documents, always include a shared `--tags` value.** This matters because the user often wants to *find the batch again later* — "show me the docs I just uploaded", "update everything from yesterday". Without a shared tag, nothing ties those posts together. Pick a tag that names the group meaningfully:

- A folder → the folder name (`--tags "api-docs"`)
- A time window → a date stamp (`--tags "notes-2026-04"`, `--tags "release-q2"`)
- A project → the project name

---

## Public visibility: require explicit confirmation

**The default visibility is `workspace`** — only workspace members can view the document. This is the right default for notes, drafts, and internal docs, and it's why the CLI doesn't require any confirmation flag for it.

**Never set `--visibility public` without explicit user consent.** Public documents are accessible to anyone on the internet with the link. If the user says "publish this doc" or "share this with the team", default to `workspace` — those phrasings are ambiguous. Before publishing publicly, ask:

> "This will make the document publicly accessible to anyone with the link. Are you sure you want it to be public?"

Only proceed with `--visibility public --confirm-public` after the user clearly says yes. The `--confirm-public` flag is a double-safety: the API itself refuses to publish publicly without it, so an accidental `--visibility public` will surface as an error rather than silently exposing the doc.

**There's also a workspace-level gate.** A workspace has an `Allow public documents` setting (default **off**) that the workspace owner controls in **Dashboard → Workspace settings**. Even after you publish a post with `--visibility public`, anonymous viewers will get a 404 until the owner enables that setting. If the user is publishing publicly for the first time and the URL doesn't load for them in an incognito window, this is almost always why — point them at workspace settings, not the post settings.

---

## Agent patterns

These compose the primitives above into the flows the user is most likely to ask for.

### "Publish this document and send me a PDF"

```bash
opendocs publish report.md --export pdf --json
```

Parse the JSON — surface both the OpenDocs URL (from `url`) and the local PDF path (from `export.path`) in the reply.

### "Upload all the docs in this folder"

Pick a shared tag that names the group — folder name, date, project name — then one command:

```bash
opendocs publish ./docs --tags "api-docs" --json
```

Parse the `results` array for per-file URLs. Tell the user: "All N docs published. Find them again with `opendocs list --tag api-docs`." The tag is the persistent handle.

### "Publish this folder and give me PDFs I can send out"

The hero workflow — one command, URLs *and* local PDFs:

```bash
opendocs publish ./docs --export pdf --tags "release-q2" --json
```

The returned JSON has `results` (publish URLs) and `export.results` (local PDF paths, one per successful publish).

### "Update the doc I published earlier"

If the user named the doc, you can skip the list step — use the slug directly:

```bash
opendocs pull my-report --stdout          # get current content (if you need it)
# ... agent edits the markdown, saves to file ...
opendocs update revised.md --post-id my-report --json
```

If the user is vague about which post, browse first:

```bash
opendocs list --json --limit 20           # find it by title/slug/recency
opendocs update revised.md --post-id <slug-or-id> --json
```

### "What did I publish recently?"

```bash
opendocs list --json --limit 50             # active workspace only
opendocs list --json --all --limit 50       # across every workspace
```

The JSON shape is `{ "posts": [...], "pagination": { "page", "limit", "total", "totalPages" }, "scope": "workspace" | "all", "workspaceSlug": "..." | null }`. Each post has `id`, `title`, `slug`, `visibility`, `isPublished`, `updatedAt`, `tags`, `workspaceId`, `workspaceSlug`. If you need *every* post (not just the first page), loop until `page === totalPages` — the `--limit` cap is 100 per page, so a workspace with 250 posts needs three calls.

**Pick the scope intentionally.** "What did I publish recently?" in an account with multiple workspaces is ambiguous — use `--all` when the user doesn't specify, or when you're not confident which workspace they mean. When the user's phrasing clearly scopes to the active workspace ("show me what's in my current workspace", "list the Acme docs"), stick with the default.

If you need the full URL or the `versionNumber` of a single post, use `opendocs get <slug> --json` — that one returns more fields per post than `list` does.

### "Publish this to the <name> workspace"

When the user names a specific workspace, confirm it's active before publishing. One list call plus a conditional switch:

```bash
opendocs workspace list --json             # find the row matching the user's description
opendocs workspace use <slug> --json       # only if activeSlug isn't already <slug>
opendocs publish report.md --json
```

Match the user's phrasing against both `name` ("Acme Docs") and `slug` ("acme-docs") — users describe workspaces either way. If the user names a workspace they aren't in, `workspace use` returns `not_a_member` and you should surface the available slugs from the list rather than retrying.

---

## Error handling

When a command fails, the CLI exits non-zero and prints a structured error. In `--json` mode, the error goes to **stderr** (not stdout) as a JSON object:

```json
{ "error": "slug_taken", "message": "That slug is already in use." }
```

Common error codes and what they mean:

| Error | What it means | How to recover |
|---|---|---|
| `document_limit` (403) | The Free-plan 10-doc cap would be exceeded. The CLI pre-checks this before any network work. | Tell the user — suggest upgrading to Pro, unpublishing stale docs, or publishing only the docs that fit. Don't retry. |
| `auth_expired` (401) | API key revoked or invalid. Config is auto-cleared. | Tell the user to run `opendocs login` with a new key. |
| `onboarding_incomplete` | Account exists but username or workspace slug aren't set. | Point them at the web app to finish setup. |
| `no_workspace` | Local config missing workspaceId (rare — config corruption). | `opendocs login` will refresh it. |
| `not_a_member` (403) | The slug passed to `opendocs workspace use` isn't one the user belongs to. | Run `opendocs workspace list` to see valid slugs, then retry with one of them. |
| `slug_taken` (409) | Post slug already used within the workspace. | Re-run without `--slug` (auto-generates) or pick a different one. |
| `doc_too_large` | File exceeds the 1 MB markdown cap. | Split the doc — this is a hard server-side limit. |
| `too_many_files` | >500 files passed in one `publish` invocation. | Split into multiple runs. |
| `no_markdown_files` | Folder input did not contain any `.md` files after skipped directories were ignored. | Check the path, or pass files explicitly. |
| `too_many_posts` | >10 postIds passed to `export`. | Split into groups of 10. |
| `invalid_format` | `--format` / `--export` wasn't `pdf` or `docx`. | Fix the flag. Note: `docx` requires Pro or Team. |
| `conflicting_options` | Flags that don't combine (e.g. `--title` with multiple files, `--stdout` with batch export). | Drop the conflicting flag. |
| `not_found` (404) | postId doesn't exist or isn't yours. | Double-check with `opendocs list`. Also check this isn't the public-visibility gate (see "Public visibility" above). |
| `confirm_required` | `opendocs delete` run without `--yes` in a non-TTY context (script / agent / pipe). No network call was made. | Add `--yes` (or `-y`) to confirm the deletion is intentional. |
| `confirm_public_required` | Visibility changed to `public` without `--confirm-public` (or the server enforced it). Caught pre-flight by the CLI. | Re-run with `--confirm-public` once the user has explicitly agreed to expose the post. |
| `delete_failed` (400) | `opendocs delete` reached the server but the transactional cleanup failed. The post may be partially deleted. | Re-run the delete — the transaction is idempotent. If it keeps failing, point the user at support. |
| `image_upload_failed` | The local-image upload phase failed hard (for example too many image refs in one doc). Individual missing/unsupported images are usually warnings, not this error. | Fix or remove the problematic image references and retry. Storage being unconfigured server-side is downgraded to a warning. |
| `export_failed` (502) | Converter service transient failure. | Retry — the post is still up if this happened during `--export`. |
| `plan_limit` (403) | Workspace count cap hit (Free: 1, Pro: 2 plus paid extras). | Direct the user to the dashboard to upgrade or add a Pro workspace. |
| `member_limit` (403) | Workspace member cap hit (Free: 3, Pro: 5). | Direct the user to the dashboard to upgrade or remove a member. |

---

## Important notes

- **The file must exist on disk as Markdown** (`.md`). The CLI reads it — you cannot pipe content to `publish`. If the agent wrote content in memory, save it to a file first.
- **Config lives at `~/.config/opendocs/config.json`** with `0600` permissions. Never modify it by hand — use `opendocs login` / `opendocs logout`.
- **Document URLs are `opendocs.cc/<workspace-slug>/<post-slug>`.** The workspace slug is the one chosen during onboarding (shared by every doc in the workspace). The post slug is auto-derived from the title unless `--slug` is set, and is immutable after first publish. Neither segment uses the username.
- **Updates create new versions.** The URL stays stable; previous versions are preserved server-side.
- **Rate limits apply.** The CLI respects them; you don't need to throttle manually, but avoid rapid-fire retries in a tight loop.
