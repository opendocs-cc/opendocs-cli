import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs update` + `opendocs unpublish`. Both are thin passthroughs to
 * POST endpoints that already have full coverage on the API side; here we
 * just validate the CLI wiring:
 *   - update reads the .md file, sends markdown + workspaceId on the body
 *   - unpublish forwards the postId to the right path
 *   - both propagate HTTP error codes cleanly
 */

describe("commands: update / unpublish", () => {
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

  // ── update ─────────────────────────────────────────────────────────────

  test("update sends markdown body and returns new versionNumber", async () => {
    api.on("POST", "/api/v1/posts/:postId/update", (req, res) => {
      const body = req.body as { visibility?: unknown; tags?: unknown };
      expect(req.params.postId).toBe("post_1");
      expect(req.body).toMatchObject({
        markdown: "# Updated\n",
        workspaceId: "ws_seed",
      });
      expect(body.visibility).toBeUndefined();
      expect(body.tags).toBeUndefined();
      respondJson(res, {
        postId: "post_1",
        versionId: "v_new",
        versionNumber: 4,
        slug: "upd",
        title: "Updated",
        visibility: "workspace",
      });
    });

    const harness2 = makeRunCli();
    try {
      // Create the source file inside a fresh cwd and run from there.
      const cwd = fs.mkdtempSync(
        path.join(path.dirname(harness2.configDir), "cwd-"),
      );
      fs.writeFileSync(path.join(cwd, "new.md"), "# Updated\n");

      const result = await harness2.run(
        ["--json", "update", "new.md", "--post-id", "post_1"],
        {
          apiUrl: api.url,
          cwd,
          config: {
            apiKey: "od_live_x",
            apiUrl: api.url,
            workspaceId: "ws_seed",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.json()).toMatchObject({
        versionNumber: 4,
        slug: "upd",
      });
    } finally {
      harness2.cleanup();
    }
  });

  test("update fails pre-flight when file is missing (no API call)", async () => {
    const result = await run(
      ["--json", "update", "./does-not-exist.md", "--post-id", "post_1"],
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
    expect(result.stderr).toMatch(/File not found/);
    expect(api.calls).toHaveLength(0);
  });

  test("update surfaces 409 slug_taken from server", async () => {
    api.on("POST", "/api/v1/posts/:postId/update", (_req, res) => {
      respondJson(res, { error: "slug_taken", message: "already taken" }, 409);
    });
    const harness2 = makeRunCli();
    try {
      const cwd = fs.mkdtempSync(
        path.join(path.dirname(harness2.configDir), "cwd-"),
      );
      fs.writeFileSync(path.join(cwd, "a.md"), "# a\n");
      const result = await harness2.run(
        ["--json", "update", "a.md", "--post-id", "p1"],
        {
          apiUrl: api.url,
          cwd,
          config: {
            apiKey: "od_live_x",
            apiUrl: api.url,
            workspaceId: "ws_1",
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "slug_taken" });
    } finally {
      harness2.cleanup();
    }
  });

  test("update errors cleanly when config has no workspaceId", async () => {
    const harness2 = makeRunCli();
    try {
      const cwd = fs.mkdtempSync(
        path.join(path.dirname(harness2.configDir), "cwd-"),
      );
      fs.writeFileSync(path.join(cwd, "a.md"), "# a\n");
      const result = await harness2.run(
        ["--json", "update", "a.md", "--post-id", "p1"],
        {
          apiUrl: api.url,
          cwd,
          // Seed config without workspaceId
          config: { apiKey: "od_live_x", apiUrl: api.url },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "no_workspace" });
      // No network call — it's a pre-flight.
      expect(api.calls).toHaveLength(0);
    } finally {
      harness2.cleanup();
    }
  });

  // ── unpublish ──────────────────────────────────────────────────────────

  test("unpublish POSTs to /posts/:id/unpublish and returns confirmation", async () => {
    api.on("POST", "/api/v1/posts/:postId/unpublish", (req, res) => {
      expect(req.params.postId).toBe("p_1");
      respondJson(res, { postId: "p_1", unpublished: true });
    });
    const result = await run(["--json", "unpublish", "p_1"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ unpublished: true, postId: "p_1" });
  });

  test("unpublish surfaces 404 for missing posts", async () => {
    api.on("POST", "/api/v1/posts/:postId/unpublish", (_req, res) => {
      respondJson(res, { error: "not_found", message: "nope" }, 404);
    });
    const result = await run(["--json", "unpublish", "ghost"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });
});
