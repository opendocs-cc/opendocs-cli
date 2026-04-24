import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * Read-side commands: `opendocs list` and `opendocs get`. These are
 * thin wrappers around /api/v1/posts and /api/v1/posts/:id — we focus on:
 *   1. Flag parsing flows through (page/limit/tag for list).
 *   2. JSON output stays a clean single object (no human-output bleed).
 *   3. Empty collections and error responses produce the right exit code.
 */

describe("commands: list / get", () => {
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

  // ── list ───────────────────────────────────────────────────────────────

  test("`ls` alias resolves to the list command", async () => {
    // `ls` is a muscle-memory alias for anyone who lives in a terminal. The
    // alias is wired at the commander level; this test just proves the route
    // actually fires so a future refactor doesn't silently drop it.
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });
    const result = await run(["--json", "ls"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].method).toBe("GET");
  });

  test("list --json passes page/limit/tag to the server", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [
          {
            id: "p1",
            slug: "s1",
            title: "T1",
            summary: null,
            visibility: "public",
            isPublished: true,
            updatedAt: new Date().toISOString(),
            tags: ["a", "b"],
          },
        ],
        pagination: { page: 2, limit: 5, total: 10, totalPages: 2 },
      });
    });

    const result = await run(
      ["--json", "list", "--page", "2", "--limit", "5", "--tag", "docs"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);

    const body = result.json<{ posts: unknown[]; pagination: { page: number } }>();
    expect(body.posts).toHaveLength(1);
    expect(body.pagination.page).toBe(2);

    const call = api.calls[0];
    expect(call.query.get("page")).toBe("2");
    expect(call.query.get("limit")).toBe("5");
    expect(call.query.get("tag")).toBe("docs");
  });

  test("list rejects invalid page and limit flags before any network call", async () => {
    const badPage = await run(["--json", "list", "--page", "-1"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(badPage.exitCode).toBe(1);
    expect(JSON.parse(badPage.stderr)).toMatchObject({ error: "invalid_page" });

    const badLimit = await run(["--json", "list", "--limit", "101"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(badLimit.exitCode).toBe(1);
    expect(JSON.parse(badLimit.stderr)).toMatchObject({ error: "invalid_limit" });
    expect(api.calls).toHaveLength(0);
  });

  test("list prints a friendly empty-state message in human mode", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });
    const result = await run(["list"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/No articles yet/);
  });

  test("list with upstream 500 exits 1 and surfaces message", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, { error: "server_error", message: "boom" }, 500);
    });
    const result = await run(["--json", "list"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "server_error" });
  });

  // ── get ────────────────────────────────────────────────────────────────

  test("get --json returns the full post payload", async () => {
    api.on("GET", "/api/v1/posts/:postId", (req, res) => {
      expect(req.params.postId).toBe("post_abc");
      respondJson(res, {
        post: {
          id: "post_abc",
          slug: "hello",
          title: "Hello",
          summary: null,
          visibility: "workspace",
          isPublished: true,
          publishedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          url: "/hello",
          versionNumber: 3,
          tags: [],
        },
      });
    });
    const result = await run(["--json", "get", "post_abc"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ post: { id: "post_abc", versionNumber: 3 } });
  });

  test("get forwards a slug argument verbatim (no client-side UUID check)", async () => {
    // The CLI treats the positional arg as opaque — whether it's a UUID or
    // a slug, the API decides what to do. This test pins that contract: if
    // someone later adds UUID validation in the CLI, this fails and forces
    // a deliberate rethink of slug-based lookups (see apps/api/src/lib/post-lookup.ts).
    api.on("GET", "/api/v1/posts/:postId", (req, res) => {
      expect(req.params.postId).toBe("sweden");
      respondJson(res, {
        post: {
          id: "d0d5d794-29fd-40e7-b76b-751b89c2c143",
          slug: "sweden",
          title: "Sweden",
          summary: null,
          visibility: "public",
          isPublished: true,
          publishedAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
          url: "/pmm/sweden",
          versionNumber: 1,
          tags: [],
        },
      });
    });
    const result = await run(["--json", "get", "sweden"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ post: { slug: "sweden" } });
  });

  test("get surfaces 404 with not_found code", async () => {
    api.on("GET", "/api/v1/posts/:postId", (_req, res) => {
      respondJson(res, { error: "not_found", message: "No such post" }, 404);
    });
    const result = await run(["--json", "get", "missing"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });
});
