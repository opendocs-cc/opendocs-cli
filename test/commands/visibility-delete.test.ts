import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs visibility` + `opendocs delete`. Both thin passthroughs to the
 * server (`POST /posts/:id/visibility` already existed; `DELETE /posts/:id`
 * was added alongside these commands). Coverage focuses on CLI wiring:
 *
 *   - visibility forwards the `--confirm-public` flag into the body
 *   - visibility short-circuits on public-without-confirm BEFORE any HTTP call
 *   - delete refuses to fire in non-TTY contexts unless --yes is passed
 *   - delete forwards workspaceId as a query string for slug disambiguation
 *
 * The interactive-prompt branch of `delete` is not covered here — the test
 * helper spawns the CLI with piped stdio (never a pty), so `isTTY` is always
 * false and the non-TTY rejection path is what runs. The primary safety rail
 * is the `--yes` requirement; the TTY prompt is a secondary UX layer.
 */

describe("commands: visibility / delete", () => {
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

  // ── visibility ─────────────────────────────────────────────────────────

  test("visibility POSTs to /posts/:id/visibility with workspaceId on the query", async () => {
    api.on("POST", "/api/v1/posts/:postId/visibility", (req, res) => {
      expect(req.params.postId).toBe("p_1");
      expect(req.query.get("workspaceId")).toBe("ws_seed");
      expect(req.body).toMatchObject({
        visibility: "private",
        // confirmPublic is always sent; server just ignores it for non-public.
        confirmPublic: false,
      });
      respondJson(res, { postId: "p_1", visibility: "private" });
    });

    const result = await run(["--json", "visibility", "p_1", "private"], {
      apiUrl: api.url,
      config: {
        apiKey: "od_live_x",
        apiUrl: api.url,
        workspaceId: "ws_seed",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      postId: "p_1",
      visibility: "private",
    });
  });

  test("visibility workspace (non-public) does not require --confirm-public", async () => {
    api.on("POST", "/api/v1/posts/:postId/visibility", (_req, res) => {
      respondJson(res, { postId: "p_1", visibility: "workspace" });
    });

    const result = await run(["--json", "visibility", "p_1", "workspace"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ visibility: "workspace" });
  });

  test("visibility public without --confirm-public fails pre-flight (no API call)", async () => {
    const result = await run(["--json", "visibility", "p_1", "public"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "confirm_public_required",
    });
    // Critical: pre-flight, so no server round-trip happened.
    expect(api.calls).toHaveLength(0);
  });

  test("visibility public with --confirm-public succeeds and forwards the flag", async () => {
    api.on("POST", "/api/v1/posts/:postId/visibility", (req, res) => {
      expect(req.body).toMatchObject({
        visibility: "public",
        confirmPublic: true,
      });
      respondJson(res, { postId: "p_1", visibility: "public" });
    });

    const result = await run(
      ["--json", "visibility", "p_1", "public", "--confirm-public"],
      {
        apiUrl: api.url,
        config: {
          apiKey: "od_live_x",
          apiUrl: api.url,
          workspaceId: "ws_1",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ visibility: "public" });
  });

  test("visibility rejects invalid level at commander layer (no API call)", async () => {
    const result = await run(["visibility", "p_1", "secret"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    // Commander exits non-zero on invalid choice and prints to stderr.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/secret/);
    expect(api.calls).toHaveLength(0);
  });

  test("visibility surfaces 404 for missing posts", async () => {
    api.on("POST", "/api/v1/posts/:postId/visibility", (_req, res) => {
      respondJson(res, { error: "not_found", message: "nope" }, 404);
    });

    const result = await run(["--json", "visibility", "ghost", "private"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });

  test("visibility surfaces server confirm_public_required error", async () => {
    // Server can also enforce this — e.g. if the CLI check gets out of sync.
    // We always send confirmPublic but simulate the server rejecting anyway.
    api.on("POST", "/api/v1/posts/:postId/visibility", (_req, res) => {
      respondJson(
        res,
        {
          error: "confirm_public_required",
          message: "server says confirm_public_required",
        },
        400,
      );
    });

    const result = await run(
      ["--json", "visibility", "p_1", "public", "--confirm-public"],
      {
        apiUrl: api.url,
        config: {
          apiKey: "od_live_x",
          apiUrl: api.url,
          workspaceId: "ws_1",
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "confirm_public_required",
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  test("delete --yes issues DELETE /posts/:id with workspaceId query param", async () => {
    api.on("DELETE", "/api/v1/posts/:postId", (req, res) => {
      expect(req.params.postId).toBe("p_1");
      expect(req.query.get("workspaceId")).toBe("ws_seed");
      respondJson(res, { postId: "p_1", deleted: true, slug: "my-article" });
    });

    const result = await run(["--json", "delete", "p_1", "--yes"], {
      apiUrl: api.url,
      config: {
        apiKey: "od_live_x",
        apiUrl: api.url,
        workspaceId: "ws_seed",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      postId: "p_1",
      deleted: true,
      slug: "my-article",
    });
  });

  test("delete -y short-flag works the same as --yes", async () => {
    api.on("DELETE", "/api/v1/posts/:postId", (_req, res) => {
      respondJson(res, { postId: "p_1", deleted: true, slug: "x" });
    });

    const result = await run(["--json", "delete", "p_1", "-y"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ deleted: true });
  });

  test("delete without --yes in non-TTY refuses and makes no network call", async () => {
    const result = await run(["--json", "delete", "p_1"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "confirm_required",
    });
    // Critical: the safety rail stopped us before any HTTP call.
    expect(api.calls).toHaveLength(0);
  });

  test("delete without --yes is refused even when stdin has content piped in", async () => {
    // Piping the correct slug to stdin must NOT bypass the --yes requirement
    // in non-TTY mode. The whole point of the rail is that scripts have to
    // opt in explicitly — not by stuffing bytes into stdin.
    const result = await run(["--json", "delete", "my-article"], {
      apiUrl: api.url,
      stdin: "my-article\n",
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "confirm_required",
    });
    expect(api.calls).toHaveLength(0);
  });

  test("delete surfaces 404 for missing posts", async () => {
    api.on("DELETE", "/api/v1/posts/:postId", (_req, res) => {
      respondJson(res, { error: "not_found", message: "nope" }, 404);
    });

    const result = await run(["--json", "delete", "ghost", "--yes"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });

  test("delete surfaces delete_failed on server-side transactional error", async () => {
    api.on("DELETE", "/api/v1/posts/:postId", (_req, res) => {
      respondJson(
        res,
        { error: "delete_failed", message: "boom" },
        400,
      );
    });

    const result = await run(["--json", "delete", "p_1", "--yes"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "delete_failed",
    });
  });

  test("delete omits workspaceId from the URL when config has none", async () => {
    // Covers the edge-case where the user is using a personal key not tied
    // to a workspace; we shouldn't force a garbage empty string into the URL.
    let observedQuery: URLSearchParams | undefined;
    api.on("DELETE", "/api/v1/posts/:postId", (req, res) => {
      observedQuery = req.query;
      respondJson(res, { postId: "p_1", deleted: true, slug: "x" });
    });

    const result = await run(["--json", "delete", "p_1", "--yes"], {
      apiUrl: api.url,
      // No workspaceId in the seeded config.
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });

    expect(result.exitCode).toBe(0);
    expect(observedQuery?.has("workspaceId")).toBe(false);
  });
});
