import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import {
  startMockApi,
  respondJson,
  respondBinary,
  sseFrame,
  type MockApi,
} from "../helpers/mock-api.js";

/**
 * `opendocs publish` has the most surface area of any command. Paths covered:
 *
 *   Single-file:
 *     - happy path (POST /publish, success message, JSON out)
 *     - --title / --slug / --tags flow through
 *     - 409 slug_taken surfaces cleanly
 *
 *   Multi-file:
 *     - --json mode hits /publish/batch (no SSE)
 *     - interactive mode streams via /publish/batch with text/event-stream
 *     - auto-chunking into groups of 10 (>10 files triggers two batches)
 *     - partial failures flow into the summary
 *
 *   --export chain:
 *     - single-file + --export uses /export/:format endpoint
 *     - multi-file + --export uses /batch/export + unpacks zip next to source
 *     - exports written next to source, NOT in cwd
 *
 *   Pre-flight:
 *     - bad --visibility not tested (server enforces; CLI passes through)
 *     - missing workspaceId → no_workspace error
 *     - bad --export value rejected
 *     - --title + >1 file rejected
 *     - >100 files rejected
 *     - 1 MB cap per file enforced
 */

/**
 * Make a child cwd + write the given .md files into it. Returns the cwd path
 * so the caller can pass it to run(). Using a fresh cwd per test prevents
 * file-system spillover between cases (auto-chunk tests write dozens of docs).
 */
function makeCwd(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-pub-cwd-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  return cwd;
}

describe("commands: publish", () => {
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

  // ── Single-file path ─────────────────────────────────────────────────

  test("single-file publish: happy path returns slug + url", async () => {
    api.on("POST", "/api/v1/publish", (req, res) => {
      expect(req.body).toMatchObject({
        markdown: "# Hello\n",
        visibility: "workspace",
        workspaceId: "ws_seed",
        sourcePath: "hello.md",
      });
      respondJson(res, {
        postId: "p_1",
        slug: "hello-slug",
        url: "/hello-slug",
        title: "Hello",
      });
    });

    const cwd = makeCwd({ "hello.md": "# Hello\n" });
    const result = await run(["--json", "publish", "hello.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_seed" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      postId: "p_1",
      slug: "hello-slug",
    });
  });

  test("single-file publish: --title / --slug / --tags are forwarded", async () => {
    api.on("POST", "/api/v1/publish", (req, res) => {
      expect(req.body).toMatchObject({
        title: "Custom Title",
        slug: "custom",
        tags: ["a", "b", "c"],
        visibility: "public",
        confirmPublic: true,
      });
      respondJson(res, {
        postId: "p",
        slug: "custom",
        url: "/custom",
        title: "Custom Title",
      });
    });
    const cwd = makeCwd({ "a.md": "# ignored\n" });
    const result = await run(
      [
        "--json",
        "publish",
        "a.md",
        "--title",
        "Custom Title",
        "--slug",
        "custom",
        "--tags",
        "a, b, c",
        "--visibility",
        "public",
        "--confirm-public",
      ],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("single-file publish: surfaces 409 slug_taken", async () => {
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(res, { error: "slug_taken", message: "taken" }, 409);
    });
    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(["--json", "publish", "a.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "slug_taken" });
  });

  // ── Pre-flight validation ───────────────────────────────────────────

  test("publish without workspaceId errors before any network call", async () => {
    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(["--json", "publish", "a.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "no_workspace" });
    expect(api.calls).toHaveLength(0);
  });

  test("publish rejects >100 files with too_many_files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 101; i++) files[`f${i}.md`] = `# ${i}\n`;
    const cwd = makeCwd(files);
    const args = ["--json", "publish", ...Object.keys(files)];
    const result = await run(args, {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "too_many_files" });
    expect(api.calls).toHaveLength(0);
  });

  test("publish rejects invalid --export format pre-flight", async () => {
    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(
      ["--json", "publish", "a.md", "--export", "html"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "invalid_format" });
    expect(api.calls).toHaveLength(0);
  });

  test("publish rejects --title with multiple files", async () => {
    const cwd = makeCwd({ "a.md": "# a\n", "b.md": "# b\n" });
    const result = await run(
      ["--json", "publish", "a.md", "b.md", "--title", "Shared"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "conflicting_options",
    });
    expect(api.calls).toHaveLength(0);
  });

  test("publish rejects a >1 MB file with doc_too_large (pre-flight)", async () => {
    const big = "#".repeat(1_100_000);
    const cwd = makeCwd({ "huge.md": big });
    const result = await run(["--json", "publish", "huge.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "doc_too_large" });
    expect(api.calls).toHaveLength(0);
  });

  // ── Multi-file: --json path hits /publish/batch with JSON response ────

  test("multi-file --json: batches into groups of 10 and aggregates results", async () => {
    const files: Record<string, string> = {};
    const names: string[] = [];
    for (let i = 0; i < 12; i++) {
      files[`d${i}.md`] = `# d${i}\n`;
      names.push(`d${i}.md`);
    }
    const cwd = makeCwd(files);

    api.on("POST", "/api/v1/publish/batch", (req, res) => {
      const body = req.body as {
        documents: Array<{ sourcePath: string }>;
      };
      const results = body.documents.map((doc, idx) => ({
        success: true,
        index: idx,
        postId: `p_${doc.sourcePath}`,
        slug: doc.sourcePath.replace(".md", ""),
        title: doc.sourcePath,
        url: `/${doc.sourcePath}`,
      }));
      respondJson(res, {
        results,
        summary: {
          total: body.documents.length,
          succeeded: body.documents.length,
          failed: 0,
        },
      });
    });

    const result = await run(["--json", "publish", ...names], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    expect(result.exitCode).toBe(0);

    // 12 docs → two batches (10 + 2).
    const batchCalls = api.calls.filter((c) => c.url === "/api/v1/publish/batch");
    expect(batchCalls).toHaveLength(2);
    expect((batchCalls[0].body as { documents: unknown[] }).documents).toHaveLength(10);
    expect((batchCalls[1].body as { documents: unknown[] }).documents).toHaveLength(2);

    const body = result.json<{
      total: number;
      succeeded: number;
      failed: number;
      results: unknown[];
    }>();
    expect(body).toMatchObject({ total: 12, succeeded: 12, failed: 0 });
    expect(body.results).toHaveLength(12);
  });

  test("multi-file --json: server partial failure flows into summary", async () => {
    const cwd = makeCwd({ "a.md": "# a\n", "b.md": "# b\n" });
    api.on("POST", "/api/v1/publish/batch", (_req, res) => {
      respondJson(res, {
        results: [
          {
            success: true,
            index: 0,
            postId: "p_a",
            slug: "a",
            title: "a",
            url: "/a",
          },
          {
            success: false,
            index: 1,
            error: "slug_taken",
            message: "b is in use",
          },
        ],
        summary: { total: 2, succeeded: 1, failed: 1 },
      });
    });

    const result = await run(["--json", "publish", "a.md", "b.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    // Partial success stays exit 0 — failures surface in the JSON body.
    expect(result.exitCode).toBe(0);
    const body = result.json<{ succeeded: number; failed: number; results: Array<{ success: boolean; error?: string }> }>();
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((r) => !r.success)?.error).toBe("slug_taken");
  });

  // ── Multi-file: interactive path uses SSE ───────────────────────────

  test("multi-file interactive: uses SSE stream, printing per-doc progress", async () => {
    const cwd = makeCwd({ "a.md": "# a\n", "b.md": "# b\n" });

    api.on("POST", "/api/v1/publish/batch", async (req, res) => {
      // Confirm the client asked for SSE — the publish command flips
      // Accept: text/event-stream in interactive mode but uses JSON when
      // --json is set.
      expect(req.headers.accept).toBe("text/event-stream");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      sseFrame(res, "result", {
        success: true,
        index: 0,
        postId: "p_a",
        slug: "a",
        title: "a",
        url: "/a",
      });
      sseFrame(res, "result", {
        success: true,
        index: 1,
        postId: "p_b",
        slug: "b",
        title: "b",
        url: "/b",
      });
      sseFrame(res, "summary", { total: 2, succeeded: 2, failed: 0 });
      res.end();
    });

    // NOT --json → interactive path (SSE).
    const result = await run(["publish", "a.md", "b.md"], {
      apiUrl: api.url,
      cwd,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
    });
    expect(result.exitCode).toBe(0);
    // Human-readable per-doc lines show up on stdout.
    expect(result.stdout).toMatch(/a\.md/);
    expect(result.stdout).toMatch(/b\.md/);
    expect(result.stdout).toMatch(/2 documents published successfully/);
  });

  // ── --export chain ─────────────────────────────────────────────────

  test("single-file publish --export writes <name>.pdf next to source", async () => {
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(res, {
        postId: "p_1",
        slug: "hello",
        url: "/hello",
        title: "Hello",
      });
    });
    const pdfBytes = Buffer.from("%PDF-fake");
    api.on("POST", "/api/v1/posts/:postId/export/:format", (req, res) => {
      expect(req.params.postId).toBe("p_1");
      expect(req.params.format).toBe("pdf");
      respondBinary(res, pdfBytes, {
        contentType: "application/pdf",
        filename: "hello.pdf",
      });
    });

    // Put the source in a nested dir so we can verify the export lands next
    // to it (NOT in cwd).
    const cwd = makeCwd({ "docs/hello.md": "# Hello\n" });
    const result = await run(
      ["--json", "publish", "docs/hello.md", "--export", "pdf"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(0);
    const outPath = path.join(cwd, "docs", "hello.pdf");
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath).equals(pdfBytes)).toBe(true);

    const body = result.json<{ export: { success: boolean; path: string } }>();
    expect(body.export.success).toBe(true);
    // publish.ts reports the relative path (as passed on the CLI), not abs.
    expect(body.export.path).toBe(path.join("docs", "hello.pdf"));
  });

  test("single-file publish --export: publish succeeds, export fails — partial success", async () => {
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(res, {
        postId: "p_1",
        slug: "s",
        url: "/s",
        title: "T",
      });
    });
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      respondJson(
        res,
        { error: "export_failed", message: "converter down" },
        502,
      );
    });
    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(
      ["--json", "publish", "a.md", "--export", "pdf"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    // Publish succeeded, export failed — exit 0 (the post IS live).
    expect(result.exitCode).toBe(0);
    const body = result.json<{
      export: { success: boolean; error: string };
    }>();
    expect(body.export.success).toBe(false);
  });

  test("single-file publish --export: non-JSON 502 body surfaces a non-empty error", async () => {
    // Regression: gateways (Caddy, load balancers) occasionally short-circuit
    // with a non-JSON error body. If the CLI swallowed that into `{ message: "" }`
    // and `??` kept the empty string, users saw "Export failed: " with no
    // explanation. Now the fallback kicks in whenever message is empty/missing.
    api.on("POST", "/api/v1/publish", (_req, res) => {
      respondJson(res, { postId: "p_1", slug: "s", url: "/s", title: "T" });
    });
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      // Non-JSON body — like what a gateway 502 actually looks like.
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain");
      res.end("Bad Gateway");
    });
    const cwd = makeCwd({ "a.md": "# a\n" });
    const result = await run(
      ["--json", "publish", "a.md", "--export", "pdf"],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(0);
    const body = result.json<{
      export: { success: boolean; error: string };
    }>();
    expect(body.export.success).toBe(false);
    expect(body.export.error).not.toBe("");
    expect(body.export.error).toMatch(/502|failed/i);
  });

  test("multi-file publish --export: unpacks batch zip into source dirs", async () => {
    const cwd = makeCwd({
      "docs/one.md": "# One\n",
      "docs/two.md": "# Two\n",
    });

    api.on("POST", "/api/v1/publish/batch", (req, res) => {
      const body = req.body as { documents: Array<{ sourcePath: string }> };
      const results = body.documents.map((doc, idx) => ({
        success: true,
        index: idx,
        postId: `p_${doc.sourcePath}`,
        slug: doc.sourcePath.replace(".md", ""),
        title: doc.sourcePath,
        url: `/${doc.sourcePath}`,
      }));
      respondJson(res, {
        results,
        summary: { total: 2, succeeded: 2, failed: 0 },
      });
    });

    const zip = new JSZip();
    const pdfOne = Buffer.from("PDF-One");
    const pdfTwo = Buffer.from("PDF-Two");
    zip.file("one.pdf", pdfOne);
    zip.file("two.pdf", pdfTwo);
    const manifest = {
      format: "pdf" as const,
      results: [
        {
          postId: "p_one.md",
          success: true as const,
          slug: "one",
          filename: "one.pdf",
          bytes: pdfOne.length,
        },
        {
          postId: "p_two.md",
          success: true as const,
          slug: "two",
          filename: "two.pdf",
          bytes: pdfTwo.length,
        },
      ],
      summary: { total: 2, succeeded: 2, failed: 0 },
    };
    zip.file("manifest.json", JSON.stringify(manifest));
    const zipBytes = await zip.generateAsync({ type: "nodebuffer" });
    const manifestB64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");

    api.on("POST", "/api/v1/posts/batch/export", (_req, res) => {
      respondBinary(res, zipBytes, {
        contentType: "application/zip",
        filename: "batch.zip",
        extraHeaders: { "X-Batch-Manifest": manifestB64 },
      });
    });

    const result = await run(
      [
        "--json",
        "publish",
        "docs/one.md",
        "docs/two.md",
        "--export",
        "pdf",
      ],
      {
        apiUrl: api.url,
        cwd,
        config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "w1" },
      },
    );
    expect(result.exitCode).toBe(0);
    // Files land next to source (docs/), NOT in cwd.
    expect(fs.readFileSync(path.join(cwd, "docs", "one.pdf")).equals(pdfOne)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "docs", "two.pdf")).equals(pdfTwo)).toBe(true);
    expect(fs.existsSync(path.join(cwd, "one.pdf"))).toBe(false);

    const body = result.json<{
      export: { total: number; succeeded: number; results: Array<{ path: string }> };
    }>();
    expect(body.export).toMatchObject({ total: 2, succeeded: 2 });
  });
});
