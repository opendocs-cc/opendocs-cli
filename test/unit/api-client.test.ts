import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createApiClient, ApiError } from "../../src/lib/api.js";
import { startMockApi, respondJson, respondBinary, sseFrame, type MockApi } from "../helpers/mock-api.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Exercises src/lib/api.ts directly (no subprocess). The ApiError + 401
 * auto-clearConfig path is critical — a single broken key should log the
 * user out cleanly, not loop forever on whatever command they typed.
 */

describe("lib/api createApiClient", () => {
  let api: MockApi;
  let xdgHome: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    api = await startMockApi();
    xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-api-test-"));
    process.env.XDG_CONFIG_HOME = xdgHome;
  });

  afterEach(async () => {
    await api.close();
    fs.rmSync(xdgHome, { recursive: true, force: true });
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  test("strips trailing slash from apiUrl before joining paths", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "u1",
        onboarding: { username: "a", workspace: { id: "w1", name: "W" } },
      });
    });
    // Client with trailing slash should produce a clean URL (no //)
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url + "/" });
    await client.me();
    expect(api.calls[0].url).toBe("/api/v1/me");
  });

  test("sends Authorization header with bearer token + user-agent", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "u1",
        onboarding: { username: "a", workspace: { id: "w1", name: "W" } },
      });
    });
    const client = createApiClient({ apiKey: "od_live_test", apiUrl: api.url });
    await client.me();
    expect(api.calls[0].headers.authorization).toBe("Bearer od_live_test");
    // Keep the User-Agent assertion tight — bumping the version should break
    // this test so we remember to audit every spot it's hard-coded.
    expect(api.calls[0].headers["user-agent"]).toMatch(/^opendocs-cli\/\d+\.\d+\.\d+$/);
  });

  test("non-OK JSON response throws ApiError with server-provided code", async () => {
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(
        res,
        { error: "slug_taken", message: "That slug is already in use." },
        409,
      );
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    await expect(
      client.publish({
        markdown: "# hi",
        visibility: "workspace",
        workspaceId: "ws_1",
      }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await client.publish({
        markdown: "# hi",
        visibility: "workspace",
        workspaceId: "ws_1",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe("slug_taken");
      expect(e.message).toMatch(/already in use/);
    }
  });

  test("401 clears stored config AND throws auth_expired ApiError", async () => {
    // Seed a config to the sandboxed XDG_CONFIG_HOME that api.ts will clear.
    const dir = path.join(xdgHome, "opendocs");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ apiKey: "od_live_revoked", apiUrl: api.url }),
    );
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, { error: "auth_expired", message: "key revoked" }, 401);
    });

    const client = createApiClient({ apiKey: "od_live_revoked", apiUrl: api.url });
    await expect(client.me()).rejects.toMatchObject({
      status: 401,
      code: "auth_expired",
    });
    // Critical: side effect — config file should be gone.
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("query params for listPosts are serialized correctly", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [],
        pagination: { page: 2, limit: 5, total: 0, totalPages: 0 },
      });
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    await client.listPosts({ page: 2, limit: 5, tag: "design" });
    const call = api.calls[0];
    expect(call.query.get("page")).toBe("2");
    expect(call.query.get("limit")).toBe("5");
    expect(call.query.get("tag")).toBe("design");
  });

  test("listPosts omits query string entirely when no opts given", async () => {
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    await client.listPosts();
    // If opts is undefined the path should be exactly /api/v1/posts (no ?)
    expect(api.calls[0].url).toBe("/api/v1/posts");
  });

  test("exportPost returns buffer + filename parsed from Content-Disposition", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake");
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      respondBinary(res, fakePdf, {
        contentType: "application/pdf",
        filename: "my-post.pdf",
      });
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const result = await client.exportPost("post_123", "pdf");
    expect(result.buffer).toEqual(fakePdf);
    expect(result.filename).toBe("my-post.pdf");
    expect(result.contentType).toBe("application/pdf");
  });

  test("exportPost falls back to 'document' when server omits Content-Disposition", async () => {
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(Buffer.from([0x00, 0x01, 0x02]));
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const result = await client.exportPost("post_x", "docx");
    expect(result.filename).toBe("document");
  });

  test("batchExportPosts decodes X-Batch-Manifest header (base64 JSON)", async () => {
    const manifest = {
      format: "pdf" as const,
      results: [
        {
          postId: "p1",
          success: true as const,
          slug: "s1",
          filename: "s1.pdf",
          bytes: 100,
        },
      ],
      summary: { total: 1, succeeded: 1, failed: 0 },
    };
    const b64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
    api.on("POST", "/api/v1/posts/batch/export", (_req, res) => {
      respondBinary(res, Buffer.from("ZIPDATA"), {
        contentType: "application/zip",
        filename: "batch.zip",
        extraHeaders: { "X-Batch-Manifest": b64 },
      });
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const result = await client.batchExportPosts({
      postIds: ["p1"],
      format: "pdf",
    });
    expect(result.manifest).toEqual(manifest);
    expect(result.buffer.toString()).toBe("ZIPDATA");
  });

  test("batchExportPosts returns null manifest when header is missing", async () => {
    api.on("POST", "/api/v1/posts/batch/export", (_req, res) => {
      respondBinary(res, Buffer.from("Z"), {
        contentType: "application/zip",
        filename: "batch.zip",
      });
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const result = await client.batchExportPosts({ postIds: ["p1"], format: "pdf" });
    expect(result.manifest).toBeNull();
  });

  test("publishBatchStream parses SSE frames into typed events", async () => {
    api.on("POST", "/api/v1/publish/batch", async (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      sseFrame(res, "result", {
        success: true,
        index: 0,
        postId: "p1",
        slug: "s1",
        title: "T1",
        url: "u1",
      });
      sseFrame(res, "result", {
        success: false,
        index: 1,
        error: "oops",
        message: "nope",
      });
      sseFrame(res, "summary", { total: 2, succeeded: 1, failed: 1 });
      res.end();
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const events: unknown[] = [];
    for await (const event of client.publishBatchStream({
      documents: [
        { markdown: "# a", visibility: "workspace", workspaceId: "w1" },
        { markdown: "# b", visibility: "workspace", workspaceId: "w1" },
      ],
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "result", data: { success: true, postId: "p1" } });
    expect(events[1]).toMatchObject({ type: "result", data: { success: false, error: "oops" } });
    expect(events[2]).toMatchObject({ type: "summary", data: { succeeded: 1, failed: 1 } });
  });

  test("publishBatchStream throws ApiError when server returns JSON error", async () => {
    api.on("POST", "/api/v1/publish/batch", (_req, res) => {
      respondJson(res, { error: "rate_limited", message: "slow down" }, 429);
    });
    const client = createApiClient({ apiKey: "od_live_x", apiUrl: api.url });
    const iter = client.publishBatchStream({
      documents: [{ markdown: "# a", visibility: "workspace", workspaceId: "w1" }],
    });
    await expect(iter.next()).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});
