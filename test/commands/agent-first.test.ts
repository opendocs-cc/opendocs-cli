import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, respondBinary, type MockApi } from "../helpers/mock-api.js";
import { errorMessageFromBody } from "../../src/lib/api.js";

/**
 * Agent-first flows: email-code signup, anonymous publishing, folder sync
 * (state file, update-instead-of-duplicate, conflicts, status, clone),
 * history/rollback, move, share, invite, workspace create, export --project
 * and the X-OpenDocs-Client header.
 */

const SEEDED = {
  apiKey: "od_live_test_seed",
  userId: "user_1",
  username: "jane",
  workspaceId: "ws_1",
  workspaceName: "Jane",
  workspaceSlug: "jane",
  projectId: "proj_default",
  projectName: "Default",
  projectSlug: "default",
};

function makeCwd(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-agent-cwd-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  return cwd;
}

function readState(cwd: string) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".opendocs", "state.json"), "utf8"));
}

function publishResponse(overrides: Record<string, unknown> = {}) {
  return {
    postId: "post_1",
    slug: "notes",
    url: "/jane/notes",
    title: "Notes",
    versionNumber: 1,
    projectId: "proj_default",
    projectSlug: "default",
    projectName: "Default",
    isDefaultProject: true,
    ...overrides,
  };
}

describe("agent-first CLI flows", () => {
  let api: MockApi;
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  // ── Signup with an email code ─────────────────────────────────────────

  test("login --email (no TTY) sends a code and prints the next command", async () => {
    api.on("POST", "/api/v1/auth/code/request", (req, res) => {
      expect(req.body).toEqual({ email: "jane@example.com" });
      expect(req.headers.authorization).toBeUndefined();
      respondJson(res, {
        success: true,
        email: "jane@example.com",
        accountExists: false,
        expiresInSeconds: 600,
        message: "sent",
      });
    });

    const result = await run(["login", "--email", "jane@example.com", "--json"], { apiUrl: api.url });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      status: "code_sent",
      next: "opendocs login --email jane@example.com --code <6-digit code from the email>",
    });
  });

  test("login --email --code saves the key and claims anonymous docs from this folder", async () => {
    const cwd = makeCwd({ "draft.md": "# Draft\n" });
    fs.mkdirSync(path.join(cwd, ".opendocs"));
    fs.writeFileSync(
      path.join(cwd, ".opendocs", "state.json"),
      JSON.stringify({
        version: 1,
        docs: {},
        anonymous: {
          "draft.md": {
            id: "anon_1",
            url: "https://opendocs.cc/a/anon_1",
            claimToken: "odc_tok",
            claimUrl: "https://opendocs.cc/claim/odc_tok",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            localHash: "x",
          },
        },
      }),
    );

    api.on("POST", "/api/v1/auth/code/verify", (req, res) => {
      expect(req.body).toEqual({ email: "jane@example.com", code: "123456", keyName: "claude-code" });
      respondJson(res, {
        apiKey: "od_live_new",
        keyName: "claude-code",
        accountCreated: true,
        userId: "user_1",
        email: "jane@example.com",
        username: "jane",
        workspace: { id: "ws_1", slug: "jane", name: "Jane" },
        defaultProject: { id: "proj_default", slug: "default", name: "Default" },
      });
    });
    api.on("POST", "/api/v1/anonymous/claim", (req, res) => {
      expect(req.headers.authorization).toBe("Bearer od_live_new");
      expect(req.body).toMatchObject({ claimToken: "odc_tok", workspaceId: "ws_1", projectId: "proj_default" });
      respondJson(res, { ...publishResponse({ postId: "post_claimed", slug: "draft", url: "/jane/draft" }), claimedFrom: "anon_1" }, 201);
    });

    const result = await run(
      ["login", "--email", "jane@example.com", "--code", "123456", "--json"],
      { apiUrl: api.url, cwd, env: { CLAUDECODE: "1" } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      success: true,
      accountCreated: true,
      claimed: [{ file: "draft.md", success: true, postId: "post_claimed" }],
    });
    const config = JSON.parse(fs.readFileSync(path.join(harness.configDir, "opendocs", "config.json"), "utf8"));
    expect(config).toMatchObject({ apiKey: "od_live_new", workspaceId: "ws_1", projectId: "proj_default" });
    const state = readState(cwd);
    expect(state.anonymous).toEqual({});
    expect(state.docs["draft.md"]).toMatchObject({ postId: "post_claimed", versionNumber: 1 });
  });

  // ── Anonymous publishing ──────────────────────────────────────────────

  test("publish without login explains both ways forward", async () => {
    const cwd = makeCwd({ "a.md": "# A\n" });
    const result = await run(["publish", "a.md", "--json"], { apiUrl: api.url, cwd });

    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBe("not_logged_in");
    expect(err.message).toContain("opendocs login --email");
    expect(err.message).toContain("--anonymous");
    expect(api.calls).toHaveLength(0);
  });

  test("publish --anonymous creates a 24h doc, then updates it in place", async () => {
    const cwd = makeCwd({ "plan.md": "# Plan\n" });
    api.on("POST", "/api/v1/anonymous/publish", (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["x-opendocs-client"]).toBe("codex");
      respondJson(res, {
        id: "anon_1",
        title: "Plan",
        url: "https://opendocs.cc/a/anon_1",
        claimToken: "odc_tok",
        claimUrl: "https://opendocs.cc/claim/odc_tok",
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        anonymous: true,
        message: "expires",
      }, 201);
    });
    api.on("PUT", "/api/v1/anonymous/:id", (req, res) => {
      expect(req.params.id).toBe("anon_1");
      expect(req.body).toMatchObject({ markdown: "# Plan v2\n", claimToken: "odc_tok" });
      respondJson(res, {
        id: "anon_1",
        title: "Plan v2",
        url: "https://opendocs.cc/a/anon_1",
        expiresAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
        anonymous: true,
      });
    });

    const first = await run(["publish", "plan.md", "--anonymous", "--json"], {
      apiUrl: api.url,
      cwd,
      env: { OPENDOCS_CLIENT: "codex" },
    });
    expect(first.exitCode).toBe(0);
    expect(first.json()).toMatchObject({
      anonymous: true,
      results: [{ file: "plan.md", action: "created", claimUrl: "https://opendocs.cc/claim/odc_tok" }],
    });
    expect(readState(cwd).anonymous["plan.md"]).toMatchObject({ id: "anon_1", claimToken: "odc_tok" });
    expect(fs.readFileSync(path.join(cwd, ".opendocs", ".gitignore"), "utf8")).toContain("*");

    fs.writeFileSync(path.join(cwd, "plan.md"), "# Plan v2\n");
    const second = await run(["publish", "plan.md", "--anonymous", "--json"], { apiUrl: api.url, cwd });
    expect(second.exitCode).toBe(0);
    expect(second.json()).toMatchObject({ results: [{ action: "updated" }] });
  });

  // ── Folder sync ───────────────────────────────────────────────────────

  test("re-publishing a tracked file updates it with conflict protection", async () => {
    const cwd = makeCwd({ "notes.md": "# Notes\n" });
    api.on("POST", "/api/v1/publish", (_req, res) => respondJson(res, publishResponse(), 201));

    const first = await run(["publish", "notes.md", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(first.exitCode).toBe(0);
    expect(readState(cwd).docs["notes.md"]).toMatchObject({ postId: "post_1", versionNumber: 1 });

    // Second publish → update with baseVersionNumber, not a new doc.
    fs.writeFileSync(path.join(cwd, "notes.md"), "# Notes\n\nMore.\n");
    let updateBody: Record<string, unknown> = {};
    api.on("POST", "/api/v1/posts/:postId/update", (req, res) => {
      updateBody = req.body as Record<string, unknown>;
      expect(req.params.postId).toBe("post_1");
      respondJson(res, { postId: "post_1", versionId: "v2", versionNumber: 2, unchanged: false, slug: "notes", url: "/jane/notes", title: "Notes", visibility: "workspace" });
    });
    const second = await run(["publish", "notes.md", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(second.exitCode).toBe(0);
    expect(updateBody).toMatchObject({ baseVersionNumber: 1, workspaceId: "ws_1" });
    expect(updateBody.visibility).toBeUndefined();
    expect(second.json()).toMatchObject({ updated: [{ file: "notes.md", action: "updated", versionNumber: 2 }] });
    expect(api.calls.filter((c) => c.url === "/api/v1/publish")).toHaveLength(1);
    expect(readState(cwd).docs["notes.md"].versionNumber).toBe(2);

    // Someone else published v3 → conflict, exit 1, state untouched.
    api.reset();
    api.on("POST", "/api/v1/posts/:postId/update", (_req, res) =>
      respondJson(res, {
        error: "version_conflict",
        message: "The document is at version 3, but your copy is based on version 2.",
        currentVersionNumber: 3,
        baseVersionNumber: 2,
      }, 409),
    );
    fs.writeFileSync(path.join(cwd, "notes.md"), "# Notes\n\nEven more.\n");
    const conflict = await run(["publish", "notes.md", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.json()).toMatchObject({ updated: [{ action: "conflict", currentVersionNumber: 3 }] });
    expect(readState(cwd).docs["notes.md"].versionNumber).toBe(2);

    // --force drops baseVersionNumber.
    api.reset();
    api.on("POST", "/api/v1/posts/:postId/update", (req, res) => {
      expect((req.body as Record<string, unknown>).baseVersionNumber).toBeUndefined();
      respondJson(res, { postId: "post_1", versionId: "v4", versionNumber: 4, slug: "notes", url: "/jane/notes", title: "Notes", visibility: "workspace" });
    });
    const forced = await run(["publish", "notes.md", "--force", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(forced.exitCode).toBe(0);
    expect(readState(cwd).docs["notes.md"].versionNumber).toBe(4);
  });

  test("re-publishing a tracked folder with --export exports every file, changed or not", async () => {
    const cwd = makeCwd({ "a.md": "# A\n", "b.md": "# B\n" });
    api.on("POST", "/api/v1/publish/batch", (_req, res) =>
      respondJson(res, {
        results: [
          { success: true, index: 0, ...publishResponse({ postId: "post_a", slug: "a", url: "/jane/a" }) },
          { success: true, index: 1, ...publishResponse({ postId: "post_b", slug: "b", url: "/jane/b" }) },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      }, 207),
    );
    expect((await run(["publish", ".", "--json"], { apiUrl: api.url, cwd, config: SEEDED })).exitCode).toBe(0);

    // A round of edits touches a.md only; the export should still cover both.
    fs.writeFileSync(path.join(cwd, "a.md"), "# A\n\nAmended.\n");
    api.reset();
    api.on("POST", "/api/v1/posts/:postId/update", (req, res) => {
      const a = req.params.postId === "post_a";
      respondJson(res, {
        postId: req.params.postId,
        versionId: a ? "v2" : "v1",
        versionNumber: a ? 2 : 1,
        unchanged: !a,
        slug: a ? "a" : "b",
        url: a ? "/jane/a" : "/jane/b",
        title: a ? "A" : "B",
        visibility: "workspace",
      });
    });
    let exported: string[] = [];
    api.on("POST", "/api/v1/posts/batch/export", async (req, res) => {
      exported = [...(req.body as { postIds: string[] }).postIds].sort();
      const zip = new JSZip();
      zip.file("a.pdf", "PDFA");
      zip.file("b.pdf", "PDFB");
      const manifest = {
        format: "pdf",
        results: [
          { postId: "post_a", success: true, slug: "a", filename: "a.pdf", bytes: 4 },
          { postId: "post_b", success: true, slug: "b", filename: "b.pdf", bytes: 4 },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      };
      respondBinary(res, await zip.generateAsync({ type: "nodebuffer" }), {
        contentType: "application/zip",
        filename: "export.zip",
        extraHeaders: { "X-Batch-Manifest": Buffer.from(JSON.stringify(manifest)).toString("base64") },
      });
    });

    const second = await run(["publish", ".", "--export", "pdf", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(second.exitCode).toBe(0);
    expect(exported).toEqual(["post_a", "post_b"]);
    expect(second.json()).toMatchObject({ export: { format: "pdf", total: 2, succeeded: 2 } });
    expect(fs.readFileSync(path.join(cwd, "a.pdf"), "utf8")).toBe("PDFA");
    expect(fs.readFileSync(path.join(cwd, "b.pdf"), "utf8")).toBe("PDFB");
  });

  test("status reports modified, behind and untracked files", async () => {
    const cwd = makeCwd({ "a.md": "# A\n", "b.md": "# B\n" });
    api.on("POST", "/api/v1/publish/batch", (_req, res) =>
      respondJson(res, {
        results: [
          { success: true, index: 0, ...publishResponse({ postId: "post_a", slug: "a", url: "/jane/a" }) },
          { success: true, index: 1, ...publishResponse({ postId: "post_b", slug: "b", url: "/jane/b" }) },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      }, 207),
    );
    const published = await run(["publish", "a.md", "b.md", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(published.exitCode).toBe(0);

    fs.writeFileSync(path.join(cwd, "a.md"), "# A changed\n");
    fs.writeFileSync(path.join(cwd, "c.md"), "# C\n");
    api.on("GET", "/api/v1/posts", (_req, res) =>
      respondJson(res, {
        posts: [
          { id: "post_a", isPublished: true, versionNumber: 1 },
          { id: "post_b", isPublished: true, versionNumber: 2 },
        ],
        pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
      }),
    );

    const status = await run(["status", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(status.exitCode).toBe(0);
    const files = status.json<{ files: Array<{ path: string; status: string }> }>().files;
    expect(files).toEqual([
      expect.objectContaining({ path: "a.md", status: "modified" }),
      expect.objectContaining({ path: "b.md", status: "behind" }),
      expect.objectContaining({ path: "c.md", status: "untracked" }),
    ]);
  });

  test("clone downloads the workspace and records state", async () => {
    const cwd = makeCwd({});
    api.on("GET", "/api/v1/projects", (_req, res) =>
      respondJson(res, {
        projects: [
          { id: "proj_default", workspaceId: "ws_1", name: "Default", slug: "default", isDefault: true, postCount: 1, updatedAt: "" },
          { id: "proj_x", workspaceId: "ws_1", name: "Client X", slug: "client-x", isDefault: false, postCount: 1, updatedAt: "" },
        ],
        defaultProject: { id: "proj_default", workspaceId: "ws_1", name: "Default", slug: "default", isDefault: true },
      }),
    );
    api.on("GET", "/api/v1/posts", (req, res) => {
      const projectId = req.query.get("projectId");
      respondJson(res, {
        posts: [
          projectId === "proj_x"
            ? { id: "post_x", slug: "brief", isPublished: true, versionNumber: 3 }
            : { id: "post_d", slug: "readme", isPublished: true, versionNumber: 1 },
        ],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
    });
    api.on("GET", "/api/v1/posts/:postId/raw", (req, res) =>
      respondJson(res, {
        postId: req.params.postId,
        markdown: `# ${req.params.postId}\n`,
        title: req.params.postId,
        slug: req.params.postId === "post_x" ? "brief" : "readme",
        versionNumber: req.params.postId === "post_x" ? 3 : 1,
      }),
    );

    const result = await run(["clone", "--json"], { apiUrl: api.url, cwd, config: SEEDED });

    expect(result.exitCode).toBe(0);
    const root = path.join(cwd, "jane");
    expect(fs.readFileSync(path.join(root, "readme.md"), "utf8")).toBe("# post_d\n");
    expect(fs.readFileSync(path.join(root, "projects", "client-x", "brief.md"), "utf8")).toBe("# post_x\n");
    const state = readState(root);
    expect(state.docs["projects/client-x/brief.md"]).toMatchObject({ postId: "post_x", versionNumber: 3, projectSlug: "client-x" });
    expect(state.docs["readme.md"]).toMatchObject({ postId: "post_d", url: "/jane/readme" });
  });

  // ── Projects ──────────────────────────────────────────────────────────

  test("publish --project creates the project the first time", async () => {
    const cwd = makeCwd({ "brief.md": "# Brief\n" });
    api.on("GET", "/api/v1/projects", (_req, res) =>
      respondJson(res, { projects: [], defaultProject: null }),
    );
    api.on("POST", "/api/v1/projects", (req, res) => {
      expect(req.body).toEqual({ workspaceId: "ws_1", name: "Client X" });
      respondJson(res, { project: { id: "proj_x", workspaceId: "ws_1", name: "Client X", slug: "client-x", isDefault: false } }, 201);
    });
    api.on("POST", "/api/v1/publish", (req, res) => {
      expect(req.body).toMatchObject({ projectId: "proj_x" });
      respondJson(res, publishResponse({ projectId: "proj_x", projectSlug: "client-x", url: "/jane/projects/client-x/brief" }), 201);
    });

    const result = await run(["publish", "brief.md", "--project", "Client X", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(result.exitCode).toBe(0);
    expect(readState(cwd).docs["brief.md"]).toMatchObject({ projectId: "proj_x", projectSlug: "client-x" });
  });

  test("export --project exports every document in batches", async () => {
    const cwd = makeCwd({});
    api.on("GET", "/api/v1/projects", (_req, res) =>
      respondJson(res, {
        projects: [{ id: "proj_x", workspaceId: "ws_1", name: "Client X", slug: "client-x", isDefault: false, postCount: 2, updatedAt: "" }],
        defaultProject: null,
      }),
    );
    api.on("GET", "/api/v1/posts", (_req, res) =>
      respondJson(res, {
        posts: [{ id: "p1", slug: "one" }, { id: "p2", slug: "two" }],
        pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
      }),
    );
    api.on("POST", "/api/v1/posts/batch/export", async (req, res) => {
      expect(req.body).toMatchObject({ postIds: ["p1", "p2"], format: "pdf", projectId: "proj_x" });
      const zip = new JSZip();
      zip.file("one.pdf", "PDF1");
      zip.file("two.pdf", "PDF2");
      const manifest = {
        format: "pdf",
        results: [
          { postId: "p1", success: true, slug: "one", filename: "one.pdf", bytes: 4 },
          { postId: "p2", success: true, slug: "two", filename: "two.pdf", bytes: 4 },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      };
      respondBinary(res, await zip.generateAsync({ type: "nodebuffer" }), {
        contentType: "application/zip",
        filename: "export.zip",
        extraHeaders: { "X-Batch-Manifest": Buffer.from(JSON.stringify(manifest)).toString("base64") },
      });
    });

    const result = await run(["export", "--project", "client-x", "-f", "pdf", "--json"], { apiUrl: api.url, cwd, config: SEEDED });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ format: "pdf", total: 2, succeeded: 2 });
    expect(fs.readFileSync(path.join(cwd, "client-x-pdf", "two.pdf"), "utf8")).toBe("PDF2");
  });

  test("move resolves a local file to its post and updates state", async () => {
    const cwd = makeCwd({ "notes.md": "# Notes\n" });
    fs.mkdirSync(path.join(cwd, ".opendocs"));
    fs.writeFileSync(
      path.join(cwd, ".opendocs", "state.json"),
      JSON.stringify({
        version: 1,
        docs: { "notes.md": { postId: "post_1", slug: "notes", url: "/jane/notes", workspaceId: "ws_1", versionNumber: 1, localHash: "x", syncedAt: "" } },
        anonymous: {},
      }),
    );
    api.on("GET", "/api/v1/projects", (_req, res) =>
      respondJson(res, {
        projects: [{ id: "proj_arch", workspaceId: "ws_1", name: "Archive", slug: "archive", isDefault: false, postCount: 0, updatedAt: "" }],
        defaultProject: null,
      }),
    );
    api.on("POST", "/api/v1/posts/:postId/move", (req, res) => {
      expect(req.params.postId).toBe("post_1");
      expect(req.body).toEqual({ projectId: "proj_arch" });
      respondJson(res, { postId: "post_1", moved: true, slug: "notes", url: "/jane/projects/archive/notes", projectId: "proj_arch", projectSlug: "archive", projectName: "Archive" });
    });

    const result = await run(["move", "notes.md", "--project", "archive", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(result.exitCode).toBe(0);
    expect(readState(cwd).docs["notes.md"]).toMatchObject({ projectSlug: "archive", url: "/jane/projects/archive/notes" });
  });

  // ── History ───────────────────────────────────────────────────────────

  test("history lists versions and rollback restores one", async () => {
    api.on("GET", "/api/v1/posts/:postId/versions", (_req, res) =>
      respondJson(res, {
        postId: "post_1",
        versions: [
          { id: "v2", versionNumber: 2, createdAt: new Date().toISOString(), createdBy: "jane", client: "cursor", restoredFromVersion: null, bytes: 10, isCurrent: true },
          { id: "v1", versionNumber: 1, createdAt: new Date().toISOString(), createdBy: "jane", client: "claude-code", restoredFromVersion: null, bytes: 8, isCurrent: false },
        ],
      }),
    );
    api.on("POST", "/api/v1/posts/:postId/versions/:n/restore", (req, res) => {
      expect(req.params).toEqual({ postId: "notes", n: "1" });
      respondJson(res, { postId: "post_1", versionId: "v3", versionNumber: 3, restoredFromVersion: 1, title: "Notes" });
    });

    const history = await run(["history", "notes"], { apiUrl: api.url, config: SEEDED });
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain("v2");
    expect(history.stdout).toContain("via cursor");

    const rollback = await run(["rollback", "notes", "v1", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(rollback.exitCode).toBe(0);
    expect(rollback.json()).toMatchObject({ versionNumber: 3, restoredFromVersion: 1 });
  });

  // ── Sharing and team ──────────────────────────────────────────────────

  test("share splits emails and @domains", async () => {
    api.on("POST", "/api/v1/posts/:postId/share", (req, res) => {
      expect(req.body).toEqual({ emails: ["sam@acme.com"], domains: ["acme.com"], notify: true });
      respondJson(res, {
        postId: "post_1",
        emails: ["sam@acme.com"],
        domains: ["acme.com"],
        added: { emails: ["sam@acme.com"], domains: ["acme.com"] },
        notified: ["sam@acme.com"],
        url: "https://opendocs.cc/jane/notes",
      });
    });

    const result = await run(["share", "notes", "Sam@Acme.com", "@acme.com", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ notified: ["sam@acme.com"] });
  });

  test("invite and workspace create use the API key", async () => {
    api.on("POST", "/api/v1/workspace/team/invite", (req, res) => {
      expect(req.body).toEqual({ email: "dana@acme.com", role: "admin", workspaceId: "ws_1" });
      respondJson(res, { invitation: { id: "inv_1", email: "dana@acme.com", role: "admin" } }, 201);
    });
    const invite = await run(["invite", "dana@acme.com", "--role", "admin", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(invite.exitCode).toBe(0);

    api.on("POST", "/api/v1/workspaces", (req, res) => {
      expect(req.body).toEqual({ name: "Acme Research" });
      respondJson(res, {
        workspace: { id: "ws_2", name: "Acme Research", slug: "acme-research", role: "owner" },
        defaultProject: { id: "proj_2", name: "Default", slug: "default" },
      }, 201);
    });
    const created = await run(["workspace", "create", "Acme Research", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(created.exitCode).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(harness.configDir, "opendocs", "config.json"), "utf8"));
    expect(config).toMatchObject({ workspaceId: "ws_2", workspaceSlug: "acme-research", projectId: "proj_2" });
  });

  test("sends X-OpenDocs-Client from --client", async () => {
    api.on("GET", "/api/v1/posts/:postId/share", (req, res) => {
      expect(req.headers["x-opendocs-client"]).toBe("my-bot");
      respondJson(res, { postId: "post_1", emails: [], domains: [] });
    });
    const result = await run(["share", "notes", "--client", "my-bot", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(result.exitCode).toBe(0);
  });
});

describe("errorMessageFromBody", () => {
  test("prefers the server message", () => {
    expect(errorMessageFromBody({ message: "Readable." }, 400)).toBe("Readable.");
  });

  test("flattens Zod issues from older servers", () => {
    expect(
      errorMessageFromBody(
        { issues: { formErrors: [], fieldErrors: { confirmPublic: ["Public publishing requires explicit confirmation."] } } },
        400,
      ),
    ).toBe("confirmPublic: Public publishing requires explicit confirmation.");
  });

  test("falls back to the status", () => {
    expect(errorMessageFromBody({}, 502)).toBe("Request failed with status 502");
  });
});

describe("team and project organization", () => {
  let api: MockApi;
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  const members = {
    members: [
      { id: "mem_owner", userId: "user_1", name: "Jane", email: "jane@acme.com", role: "owner" },
      { id: "mem_dana", userId: "user_2", name: "Dana", email: "dana@acme.com", role: "member" },
    ],
  };

  test("team list, role and remove resolve people by email", async () => {
    api.on("GET", "/api/v1/workspace/team", (_req, res) => respondJson(res, members));
    api.on("GET", "/api/v1/workspace/team/invitations", (_req, res) =>
      respondJson(res, { invitations: [{ id: "inv_1", email: "sam@acme.com", role: "member", invitedAt: "", invitedByName: "Jane" }] }),
    );
    api.on("GET", "/api/v1/workspace/auto-join", (_req, res) => respondJson(res, { domains: [{ domain: "acme.com", createdAt: "" }] }));
    api.on("PATCH", "/api/v1/workspace/team/members/:id/role", (req, res) => {
      expect(req.params.id).toBe("mem_dana");
      expect(req.body).toEqual({ role: "admin" });
      respondJson(res, { member: {} });
    });
    api.on("DELETE", "/api/v1/workspace/team/members/:id", (req, res) => {
      expect(req.params.id).toBe("mem_dana");
      respondJson(res, { success: true });
    });

    const list = await run(["team", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(list.exitCode).toBe(0);
    expect(list.json()).toMatchObject({ invitations: [{ email: "sam@acme.com" }], autoJoinDomains: ["acme.com"] });

    const role = await run(["team", "role", "Dana@acme.com", "admin", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(role.exitCode).toBe(0);

    const noYes = await run(["team", "remove", "dana@acme.com", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(noYes.exitCode).toBe(1);
    expect(JSON.parse(noYes.stderr).error).toBe("confirm_required");

    const removed = await run(["team", "remove", "dana@acme.com", "--yes", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(removed.exitCode).toBe(0);
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  test("team join accepts the only invitation and switches workspace", async () => {
    api.on("GET", "/api/v1/me/invitations", (_req, res) =>
      respondJson(res, {
        emailVerified: true,
        invitations: [{ id: "inv_9", workspaceId: "ws_acme", workspaceName: "Acme", workspaceSlug: "acme", role: "member", invitedByName: "Jane", expiresAt: "" }],
        joinable: [],
      }),
    );
    api.on("POST", "/api/v1/invitations/:id/accept", (req, res) => {
      expect(req.params.id).toBe("inv_9");
      respondJson(res, { workspace: { id: "ws_acme", name: "Acme", slug: "acme" }, role: "member", alreadyMember: false });
    });

    const result = await run(["team", "join", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ via: "invite", active: true });
    const config = JSON.parse(fs.readFileSync(path.join(harness.configDir, "opendocs", "config.json"), "utf8"));
    expect(config).toMatchObject({ workspaceId: "ws_acme", workspaceSlug: "acme" });
    expect(config.projectId).toBeUndefined();
  });

  test("team join uses the domain rule when there is no invitation", async () => {
    api.on("GET", "/api/v1/me/invitations", (_req, res) =>
      respondJson(res, {
        emailVerified: true,
        invitations: [],
        joinable: [{ workspaceId: "ws_acme", workspaceName: "Acme", workspaceSlug: "acme", domain: "acme.com" }],
      }),
    );
    api.on("POST", "/api/v1/workspaces/:ws/join", (req, res) => {
      expect(req.params.ws).toBe("acme");
      respondJson(res, { workspace: { id: "ws_acme", name: "Acme", slug: "acme" }, role: "member", alreadyMember: false });
    });
    const result = await run(["team", "join", "acme", "--no-switch", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ via: "domain", active: false });
  });

  test("login reports pending invitations", async () => {
    api.on("POST", "/api/v1/auth/code/verify", (_req, res) =>
      respondJson(res, {
        apiKey: "od_live_new",
        keyName: "cli",
        accountCreated: false,
        userId: "user_2",
        email: "dana@acme.com",
        username: "dana",
        workspace: { id: "ws_d", slug: "dana", name: "Dana" },
        defaultProject: { id: "proj_d", slug: "default", name: "Default" },
      }),
    );
    api.on("GET", "/api/v1/me/invitations", (_req, res) =>
      respondJson(res, {
        emailVerified: true,
        invitations: [{ id: "inv_9", workspaceId: "ws_acme", workspaceName: "Acme", workspaceSlug: "acme", role: "member", invitedByName: "Jane", expiresAt: "" }],
        joinable: [],
      }),
    );
    const result = await run(["login", "--email", "dana@acme.com", "--code", "123456", "--json"], { apiUrl: api.url });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ pendingInvitations: [{ workspaceSlug: "acme", via: "invitation", invitedBy: "Jane" }] });
  });

  test("config set organize is stored and reported by whoami", async () => {
    const set = await run(["config", "set", "organize", "auto", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(set.exitCode).toBe(0);
    const bad = await run(["config", "set", "organize", "sometimes", "--json"], { apiUrl: api.url });
    expect(bad.exitCode).toBe(1);
    const get = await run(["config", "get", "--json"], { apiUrl: api.url });
    expect(get.json()).toEqual({ organize: "auto" });

    api.on("GET", "/api/v1/me", (_req, res) => respondJson(res, { authenticated: true, userId: "user_1", onboarding: { username: "jane" } }));
    api.on("GET", "/api/v1/workspaces", (_req, res) => respondJson(res, { workspaces: [] }));
    const who = await run(["whoami", "--json"], { apiUrl: api.url });
    expect(who.json()).toMatchObject({ organize: "auto", folderProject: null });
  });

  test("project link routes new files from this folder; --project and clone paths win", async () => {
    const cwd = makeCwd({ "brief.md": "# Brief\n", "projects/client-x/notes.md": "# Notes\n" });
    const projectList = {
      projects: [
        { id: "proj_default", workspaceId: "ws_1", name: "Default", slug: "default", isDefault: true, postCount: 1, updatedAt: "", recentTitles: ["Readme"] },
        { id: "proj_launch", workspaceId: "ws_1", name: "Launch", slug: "launch", isDefault: false, postCount: 0, updatedAt: "", recentTitles: [] },
        { id: "proj_x", workspaceId: "ws_1", name: "Client X", slug: "client-x", isDefault: false, postCount: 0, updatedAt: "", recentTitles: [] },
      ],
      defaultProject: null,
    };
    api.on("GET", "/api/v1/projects", (_req, res) => respondJson(res, projectList));

    const link = await run(["project", "link", "launch", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(link.exitCode).toBe(0);
    expect(readState(cwd).project).toEqual({ id: "proj_launch", slug: "launch", name: "Launch" });

    const current = await run(["project", "current", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(current.json()).toMatchObject({ source: "folder", projectSlug: "launch" });

    api.on("POST", "/api/v1/publish/batch", (req, res) => {
      const docs = (req.body as { documents: Array<{ sourcePath: string; projectId?: string }> }).documents;
      const byFile = Object.fromEntries(docs.map((d) => [d.sourcePath, d.projectId]));
      expect(byFile).toEqual({ "brief.md": "proj_launch", "projects/client-x/notes.md": "proj_x" });
      respondJson(res, {
        results: docs.map((d, index) => ({ success: true, index, ...publishResponse({ postId: `p${index}`, slug: `s${index}`, url: `/jane/s${index}` }) })),
        summary: { total: docs.length, succeeded: docs.length, failed: 0 },
      }, 207);
    });
    const published = await run(["publish", "brief.md", "projects/client-x/notes.md", "--json"], { apiUrl: api.url, cwd, config: SEEDED });
    expect(published.exitCode).toBe(0);

    const cwd2 = makeCwd({ "a.md": "# A\n" });
    fs.mkdirSync(path.join(cwd2, ".opendocs"));
    fs.writeFileSync(path.join(cwd2, ".opendocs", "state.json"), JSON.stringify({ version: 1, docs: {}, anonymous: {}, workspaceId: "ws_1", project: { id: "proj_launch", slug: "launch", name: "Launch" } }));
    api.on("POST", "/api/v1/publish", (req, res) => {
      expect((req.body as { projectId?: string }).projectId).toBe("proj_x");
      respondJson(res, publishResponse(), 201);
    });
    const flagged = await run(["publish", "a.md", "--project", "client-x", "--json"], { apiUrl: api.url, cwd: cwd2, config: SEEDED });
    expect(flagged.exitCode).toBe(0);
    expect(flagged.json()).toMatchObject({ projectSource: "flag" });
  });
});

describe("export theme", () => {
  let api: MockApi;
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  const branding = (overrides: Record<string, unknown> = {}) => ({
    workspace: { id: "ws_1", slug: "acme", name: "Acme" },
    role: "owner",
    tier: "pro",
    canEdit: true,
    branding: {
      brandColor: "#2E1C5C",
      font: "Arial",
      preset: "classic",
      contrast: { contrast: 14.6, level: "great" },
      logoUrl: null,
      showLogoInExports: false,
      footer: { enabled: true, companyName: null, tagline: null, linkUrl: null, linkLabel: null },
      ...overrides,
    },
    presets: [
      { id: "classic", name: "Classic", description: "House style.", brandColor: "#2E1C5C", fontId: "Arial" },
      { id: "editorial", name: "Editorial", description: "Long reports.", brandColor: "#6E1F2A", fontId: "Vollkorn" },
    ],
    fonts: [{ id: "Vollkorn", label: "Vollkorn", category: "serif", description: "Editorial serif." }],
    guidelines: { minContrast: 4.5, recommendedContrast: 7, rules: [] },
  });

  test("shows the theme and checks colors locally", async () => {
    api.on("GET", "/api/v1/workspace/branding", (req, res) => {
      expect(req.query.get("workspaceId")).toBe("ws_1");
      respondJson(res, branding());
    });

    const shown = await run(["theme", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(shown.exitCode).toBe(0);
    expect(shown.json()).toMatchObject({ brandColor: "#2E1C5C", preset: "classic", canEdit: true });

    const light = await run(["theme", "check", "f5d90a", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(light.json()).toMatchObject({ brandColor: "#F5D90A", level: "too_light" });
    const dark = await run(["theme", "check", "#13294B", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(dark.json()).toMatchObject({ level: "great" });
  });

  test("changes need --yes when not interactive, then send one update", async () => {
    api.on("GET", "/api/v1/workspace/branding", (_req, res) => respondJson(res, branding()));
    api.on("PATCH", "/api/v1/workspace/branding", (req, res) => {
      expect(req.body).toEqual({ workspaceId: "ws_1", preset: "editorial", font: "Merriweather" });
      respondJson(res, branding({ brandColor: "#6E1F2A", font: "Merriweather", preset: null }));
    });

    const unconfirmed = await run(["theme", "set", "--preset", "editorial", "--font", "Merriweather", "--json"], {
      apiUrl: api.url,
      config: SEEDED,
    });
    expect(unconfirmed.exitCode).toBe(1);
    expect(JSON.parse(unconfirmed.stderr).error).toBe("confirm_required");
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    const applied = await run(["theme", "set", "--preset", "editorial", "--font", "Merriweather", "--yes", "--json"], {
      apiUrl: api.url,
      config: SEEDED,
    });
    expect(applied.exitCode).toBe(0);
    expect(applied.json()).toMatchObject({ brandColor: "#6E1F2A", font: "Merriweather" });
  });

  test("passes the API's low-contrast refusal through and validates input first", async () => {
    api.on("GET", "/api/v1/workspace/branding", (_req, res) => respondJson(res, branding()));
    api.on("PATCH", "/api/v1/workspace/branding", (_req, res) =>
      respondJson(res, { error: "low_contrast", contrast: 1.42, minContrast: 4.5, message: "That brand color is too light." }, 400),
    );

    const refused = await run(["theme", "set", "--color", "#f5d90a", "--yes", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr).error).toBe("low_contrast");

    const badHex = await run(["theme", "set", "--color", "navy", "--yes", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(JSON.parse(badHex.stderr).error).toBe("invalid_color");

    const empty = await run(["theme", "set", "--yes", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(JSON.parse(empty.stderr).error).toBe("nothing_to_change");

    const footer = await run(["theme", "footer", "--on", "--off", "--json"], { apiUrl: api.url, config: SEEDED });
    expect(JSON.parse(footer.stderr).error).toBe("invalid_option");
  });
});
