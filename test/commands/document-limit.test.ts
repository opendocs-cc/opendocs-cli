import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import {
  startMockApi,
  respondJson,
  type MockApi,
} from "../helpers/mock-api.js";

/**
 * Covers the Free-plan document-limit UX for `opendocs publish`:
 *
 *   Client pre-check (saves a round-trip + avoids partial publishes):
 *     - /me reports remaining=N, publishing N+1 files → abort before any publish call
 *     - /me reports remaining=null (Pro/Team unlimited) → pre-check skipped
 *     - /me returns 500 → pre-check is non-fatal, the publish call still runs
 *     - exact-fit (remaining=N, publishing N files) → pre-check passes
 *
 *   Server 403 fallback (source of truth — the pre-check can be stale):
 *     - single /publish returns 403 document_limit → surfaced with the server's message
 *     - /publish/batch returns 403 document_limit → surfaced with the server's message
 */

function makeCwd(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-limit-cwd-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  return cwd;
}

/** Standard /me success response with an attached document quota. */
function meResponse(quota: {
  plan: "free" | "pro" | "team";
  limit: number | null;
  used: number;
  remaining: number | null;
}) {
  return {
    authenticated: true,
    userId: "u_test",
    onboarding: {
      username: "tester",
      workspace: { id: "w1", name: "Test", slug: "test" },
    },
    quota: {
      documents: quota,
    },
  };
}

describe("commands: publish — document_limit", () => {
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

  // ── Client-side pre-check ───────────────────────────────────────────

  test("aborts before any publish call when job exceeds remaining quota", async () => {
    // Free plan at 9/10 — only 1 slot left, user tries to publish 3.
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "free", limit: 10, used: 9, remaining: 1 }),
      );
    });

    const cwd = makeCwd({
      "a.md": "# a\n",
      "b.md": "# b\n",
      "c.md": "# c\n",
    });
    const result = await run(
      ["--json", "publish", "a.md", "b.md", "c.md"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );

    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr) as { error: string; message: string };
    expect(err.error).toBe("document_limit");
    // Message must include the key numbers so the user knows exactly what to fix.
    expect(err.message).toMatch(/3 files/);
    expect(err.message).toMatch(/free plan/);
    expect(err.message).toMatch(/1 slot left/);
    expect(err.message).toMatch(/9\/10/);

    // Atomicity: no publish call should have been made. The only recorded
    // call is the pre-check /me.
    const publishCalls = api.calls.filter(
      (c) => c.url === "/api/v1/publish" || c.url === "/api/v1/publish/batch",
    );
    expect(publishCalls).toHaveLength(0);
  });

  test("singular 'file' / 'slot' wording in the pre-check message", async () => {
    // Free plan at 10/10 — 0 slots, user tries to publish 1. Tests that
    // the pluralization branch picks "1 file" and "0 slots left" correctly.
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "free", limit: 10, used: 10, remaining: 0 }),
      );
    });

    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(["--json", "publish", "a.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });

    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr) as { error: string; message: string };
    expect(err.error).toBe("document_limit");
    expect(err.message).toMatch(/1 file:/);
    expect(err.message).toMatch(/0 slots left/);
    expect(api.calls.filter((c) => c.url === "/api/v1/publish")).toHaveLength(0);
  });

  test("unlimited quota (remaining=null) skips the pre-check", async () => {
    // Pro plan — unlimited. User publishes 3 files; all three must reach
    // the batch endpoint without a client-side block.
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "pro", limit: null, used: 42, remaining: null }),
      );
    });
    api.on("POST", "/api/v1/publish/batch", (req, res) => {
      const body = req.body as { documents: Array<{ sourcePath: string }> };
      respondJson(res, {
        results: body.documents.map((doc, i) => ({
          success: true,
          index: i,
          postId: `p_${i}`,
          slug: doc.sourcePath.replace(".md", ""),
          title: doc.sourcePath,
          url: `/${doc.sourcePath}`,
        })),
        summary: { total: body.documents.length, succeeded: body.documents.length, failed: 0 },
      });
    });

    const cwd = makeCwd({
      "a.md": "# a\n",
      "b.md": "# b\n",
      "c.md": "# c\n",
    });
    const result = await run(
      ["--json", "publish", "a.md", "b.md", "c.md"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );

    expect(result.exitCode).toBe(0);
    const batchCalls = api.calls.filter((c) => c.url === "/api/v1/publish/batch");
    expect(batchCalls).toHaveLength(1);
    expect((batchCalls[0].body as { documents: unknown[] }).documents).toHaveLength(3);
  });

  test("exact-fit (publishing === remaining) passes the pre-check", async () => {
    // Free plan at 8/10 — publishing 2 fills it exactly. The CLI must
    // send the batch (the server will then return 10/10 at the end).
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "free", limit: 10, used: 8, remaining: 2 }),
      );
    });
    api.on("POST", "/api/v1/publish/batch", (_req, res) => {
      respondJson(res, {
        results: [
          { success: true, index: 0, postId: "p_a", slug: "a", title: "a", url: "/a" },
          { success: true, index: 1, postId: "p_b", slug: "b", title: "b", url: "/b" },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      });
    });

    const cwd = makeCwd({ "a.md": "# a\n", "b.md": "# b\n" });
    const result = await run(["--json", "publish", "a.md", "b.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });

    expect(result.exitCode).toBe(0);
    const batchCalls = api.calls.filter((c) => c.url === "/api/v1/publish/batch");
    expect(batchCalls).toHaveLength(1);
  });

  test("/me failure is non-fatal — publish still runs, server enforces", async () => {
    // /me is best-effort. If it blows up (network, 500, whatever) the CLI
    // should fall through and let /publish be the source of truth. The
    // try/catch around `await client.me()` makes this path.
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, { error: "server_error", message: "oops" }, 500);
    });
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(res, {
        postId: "p_1",
        slug: "hello",
        url: "/hello",
        title: "Hello",
      });
    });

    const cwd = makeCwd({ "hello.md": "# Hello\n" });
    const result = await run(["--json", "publish", "hello.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ postId: "p_1", slug: "hello" });
    // And the publish call DID reach the server despite /me failing.
    expect(
      api.calls.filter((c) => c.url === "/api/v1/publish"),
    ).toHaveLength(1);
  });

  // ── Server 403 fallback ─────────────────────────────────────────────

  test("surfaces server 403 document_limit on single publish (when pre-check misses)", async () => {
    // Cache-skew scenario: /me reports plenty of room, but between the
    // pre-check and the publish call another session filled the quota.
    // The server returns 403; the CLI must exit with the server's code +
    // message instead of swallowing it as a generic publish_failed.
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "free", limit: 10, used: 5, remaining: 5 }),
      );
    });
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(
        res,
        {
          error: "document_limit",
          plan: "free",
          limit: 10,
          used: 10,
          message: "Your free plan allows 10 published documents. You currently have 10.",
        },
        403,
      );
    });

    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(["--json", "publish", "a.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });

    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr) as { error: string; message: string };
    expect(err.error).toBe("document_limit");
    expect(err.message).toContain("10 published documents");
  });

  test("surfaces server 403 document_limit on batch publish (when pre-check misses)", async () => {
    // Same as above but for the batch path — the server's atomic
    // pre-check inside /publish/batch returns 403 for the whole payload.
    // Unlike the single-file path, the batch path treats an API-level
    // failure as an aborted run: it emits `{ aborted, abortReason, ... }`
    // on stdout (as JSON) and exits 1. The server's message must survive
    // into `abortReason` so users see "1 slot left" instead of a generic
    // "publish failed".
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(
        res,
        meResponse({ plan: "free", limit: 10, used: 5, remaining: 5 }),
      );
    });
    api.on("POST", "/api/v1/publish/batch", (_req, res) => {
      respondJson(
        res,
        {
          error: "document_limit",
          plan: "free",
          limit: 10,
          used: 9,
          requested: 3,
          workspaceId: "w1",
          message:
            "This batch would publish 3 documents, but your free plan allows 10 total. You have 1 slot left.",
        },
        403,
      );
    });

    const cwd = makeCwd({
      "a.md": "# a\n",
      "b.md": "# b\n",
      "c.md": "# c\n",
    });
    const result = await run(
      ["--json", "publish", "a.md", "b.md", "c.md"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );

    expect(result.exitCode).toBe(1);
    const body = result.json<{
      total: number;
      attempted: number;
      succeeded: number;
      notAttempted: number;
      aborted: boolean;
      abortReason: string;
    }>();
    expect(body.aborted).toBe(true);
    expect(body.attempted).toBe(0);
    expect(body.succeeded).toBe(0);
    expect(body.notAttempted).toBe(3);
    // The server's message must survive end-to-end — it's what tells the
    // user *why* the job aborted.
    expect(body.abortReason).toContain("1 slot left");
  });
});
