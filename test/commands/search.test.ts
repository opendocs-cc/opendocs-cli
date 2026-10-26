import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs search`: free-text search over /api/v1/posts?q=. It covers
 * every project in the active workspace, and points at `pull <id>` since
 * a slug lookup only sees the active project.
 */

const config = (url: string) => ({
  apiKey: "od_live_x",
  apiUrl: url,
  workspaceId: "ws1",
  workspaceSlug: "acme",
  workspaceName: "Acme",
  projectId: "proj-default",
});

const post = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "acme-nda",
  title: "Acme NDA",
  summary: "Mutual NDA with Acme Corp.",
  visibility: "workspace",
  isPublished: true,
  updatedAt: "2026-10-01T00:00:00.000Z",
  tags: [],
  workspaceId: "ws1",
  workspaceSlug: "acme",
  projectId: "proj-legal",
  projectSlug: "legal",
  projectName: "Legal",
  isDefaultProject: false,
  versionNumber: 1,
};

describe("commands: search", () => {
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

  test("searches every project in the active workspace", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, { posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    });
    const result = await run(["--json", "search", "acme", "nda"], { apiUrl: api.url, config: config(api.url) });
    expect(result.exitCode).toBe(0);

    const call = api.calls[0];
    expect(call.query.get("q")).toBe("acme nda");
    expect(call.query.get("workspaceId")).toBe("ws1");
    // Not narrowed to the active project.
    expect(call.query.get("projectId")).toBeNull();

    const body = result.json<{ query: string; posts: Array<{ id: string }>; scope: string }>();
    expect(body.query).toBe("acme nda");
    expect(body.posts[0].id).toBe(post.id);
    expect(body.scope).toBe("workspace");
  });

  test("--project narrows to one project and --all spans workspaces", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          { id: "proj-default", workspaceId: "ws1", name: "Default", slug: "default", isDefault: true, postCount: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "proj-legal", workspaceId: "ws1", name: "Legal", slug: "legal", isDefault: false, postCount: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
    });
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, { posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    });

    const scoped = await run(["--json", "search", "nda", "--project", "legal"], { apiUrl: api.url, config: config(api.url) });
    expect(scoped.exitCode).toBe(0);
    const postsCall = api.calls.find((c) => c.url.startsWith("/api/v1/posts"))!;
    expect(postsCall.query.get("projectId")).toBe("proj-legal");

    api.calls.length = 0;
    const all = await run(["--json", "search", "nda", "--all"], { apiUrl: api.url, config: config(api.url) });
    expect(all.exitCode).toBe(0);
    expect(api.calls[0].query.get("workspaceId")).toBeNull();
    expect(all.json<{ scope: string }>().scope).toBe("all");
  });

  test("human output shows the project and points at pull by ID", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, { posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    });
    const result = await run(["search", "nda"], { apiUrl: api.url, config: config(api.url) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Acme NDA/);
    expect(result.stdout).toMatch(/Legal/);
    expect(result.stdout).toContain(post.id);
    expect(result.stdout).toMatch(/opendocs pull <id> --stdout/);
  });

  test("no matches says so; a bad --limit fails before any request", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, { posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    });
    const none = await run(["search", "zebra"], { apiUrl: api.url, config: config(api.url) });
    expect(none.exitCode).toBe(0);
    expect(none.stdout + none.stderr).toMatch(/No documents in Acme match "zebra"/);

    api.calls.length = 0;
    const bad = await run(["--json", "search", "nda", "--limit", "500"], { apiUrl: api.url, config: config(api.url) });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: "invalid_limit" });
    expect(api.calls).toHaveLength(0);
  });
});
