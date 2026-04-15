import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import {
  startMockApi,
  respondJson,
  respondBinary,
  type MockApi,
} from "../helpers/mock-api.js";

/**
 * `opendocs export` has two modes:
 *   - single postId: hits /api/v1/posts/:id/export/:format, writes one file
 *   - multiple postIds (up to 10): hits /api/v1/posts/batch/export, unpacks zip
 *
 * Plus a few cross-cutting concerns:
 *   - --format validation (docx | pdf)
 *   - --stdout incompatible with multi-postId
 *   - over-limit postId count caught pre-flight
 *   - --output behaves as a FILE path in single mode, DIRECTORY in multi mode
 *
 * We also assert that the binary body reaches disk byte-for-byte — the
 * conversion pipeline doesn't care what format it is as long as bytes survive.
 */

describe("commands: export", () => {
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

  // ── Pre-flight validation ──────────────────────────────────────────────

  test("rejects invalid --format before any network call", async () => {
    const result = await run(
      ["--json", "export", "p1", "--format", "html"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "invalid_format" });
    expect(api.calls).toHaveLength(0);
  });

  test("rejects --stdout when multiple postIds are passed", async () => {
    const result = await run(
      ["--json", "export", "p1", "p2", "--format", "pdf", "--stdout"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "conflicting_options",
    });
    expect(api.calls).toHaveLength(0);
  });

  test("rejects >10 postIds (matches server-side MAX_BATCH_SIZE)", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const result = await run(
      ["--json", "export", ...ids, "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "too_many_posts" });
    expect(api.calls).toHaveLength(0);
  });

  // ── Single-postId mode ─────────────────────────────────────────────────

  test("single export writes the binary to disk under the server filename", async () => {
    const fakePdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])),
    ]);
    api.on("POST", "/api/v1/posts/:postId/export/:format", (req, res) => {
      expect(req.params.format).toBe("pdf");
      respondBinary(res, fakePdf, {
        contentType: "application/pdf",
        filename: "my-post.pdf",
      });
    });

    const result = await run(
      ["--json", "export", "post_1", "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);
    const body = result.json<{ filename: string; bytes: number }>();
    // filename in the JSON result is the OUTPUT PATH, which defaults to the
    // server-provided filename.
    expect(body.filename).toBe("my-post.pdf");
    const onDisk = fs.readFileSync(path.join(result.cwd, "my-post.pdf"));
    expect(onDisk.equals(fakePdf)).toBe(true);
    expect(body.bytes).toBe(fakePdf.length);
  });

  test("single export forwards landscape + accent_color to server", async () => {
    api.on("POST", "/api/v1/posts/:postId/export/:format", (req, res) => {
      expect(req.body).toMatchObject({
        landscape: true,
        accent_color: "#14306E",
      });
      respondBinary(res, Buffer.from("x"), {
        contentType: "application/pdf",
        filename: "x.pdf",
      });
    });
    const result = await run(
      [
        "--json",
        "export",
        "p1",
        "--format",
        "pdf",
        "--landscape",
        "--accent-color",
        "#14306E",
      ],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("single export --stdout pipes raw bytes (no file on disk)", async () => {
    // Use bytes that include a NUL — proves the binary stream isn't mangled
    // by text encoding on the way through the subprocess pipe.
    const bytes = Buffer.from([0x01, 0x00, 0x02, 0xFF, 0xFE, 0x7f]);
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      respondBinary(res, bytes, {
        contentType: "application/pdf",
        filename: "ignored.pdf",
      });
    });

    const result = await run(
      ["export", "post_1", "--format", "pdf", "--stdout"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);
    // No file should have been written to cwd.
    expect(fs.readdirSync(result.cwd)).toHaveLength(0);
    // And stdout should be exactly the bytes we sent.
    expect(result.stdoutBuffer.equals(bytes)).toBe(true);
  });

  test("single export -o <path> writes to the explicit path", async () => {
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      respondBinary(res, Buffer.from("DATA"), {
        contentType: "application/pdf",
        filename: "server-chosen.pdf",
      });
    });
    const result = await run(
      ["--json", "export", "p1", "--format", "pdf", "-o", "custom.pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(result.cwd, "custom.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(result.cwd, "server-chosen.pdf"))).toBe(false);
  });

  test("single export surfaces 404 from server cleanly", async () => {
    api.on("POST", "/api/v1/posts/:postId/export/:format", (_req, res) => {
      respondJson(res, { error: "not_found", message: "no post" }, 404);
    });
    const result = await run(
      ["--json", "export", "missing", "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });

  // ── Multi-postId (batch) mode ──────────────────────────────────────────

  test("batch export unpacks zip and writes each file", async () => {
    // Build a fake zip with two docs + a manifest.
    const zip = new JSZip();
    const pdf1 = Buffer.from("%PDF-one");
    const pdf2 = Buffer.from("%PDF-two");
    zip.file("doc-one.pdf", pdf1);
    zip.file("doc-two.pdf", pdf2);

    const manifest = {
      format: "pdf" as const,
      results: [
        {
          postId: "p1",
          success: true as const,
          slug: "doc-one",
          filename: "doc-one.pdf",
          bytes: pdf1.length,
        },
        {
          postId: "p2",
          success: true as const,
          slug: "doc-two",
          filename: "doc-two.pdf",
          bytes: pdf2.length,
        },
      ],
      summary: { total: 2, succeeded: 2, failed: 0 },
    };
    zip.file("manifest.json", JSON.stringify(manifest));
    const zipBytes = await zip.generateAsync({ type: "nodebuffer" });
    const manifestB64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");

    api.on("POST", "/api/v1/posts/batch/export", (req, res) => {
      expect(req.body).toMatchObject({
        postIds: ["p1", "p2"],
        format: "pdf",
      });
      respondBinary(res, zipBytes, {
        contentType: "application/zip",
        filename: "opendocs-export-2docs.zip",
        extraHeaders: { "X-Batch-Manifest": manifestB64 },
      });
    });

    const result = await run(
      ["--json", "export", "p1", "p2", "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);

    // Both files unpacked into cwd.
    expect(fs.readFileSync(path.join(result.cwd, "doc-one.pdf")).equals(pdf1)).toBe(true);
    expect(fs.readFileSync(path.join(result.cwd, "doc-two.pdf")).equals(pdf2)).toBe(true);

    const body = result.json<{
      total: number;
      succeeded: number;
      failed: number;
      results: unknown[];
    }>();
    expect(body).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(body.results).toHaveLength(2);
  });

  test("batch export -o <dir> writes all files into the directory", async () => {
    const zip = new JSZip();
    const pdf = Buffer.from("PDF");
    zip.file("a.pdf", pdf);
    const manifest = {
      format: "pdf" as const,
      results: [
        {
          postId: "p1",
          success: true as const,
          slug: "a",
          filename: "a.pdf",
          bytes: pdf.length,
        },
      ],
      summary: { total: 1, succeeded: 1, failed: 0 },
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

    // Two postIds trigger batch mode even though only one will succeed.
    const result = await run(
      ["--json", "export", "p1", "p2", "--format", "pdf", "-o", "out"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(result.cwd, "out", "a.pdf"))).toBe(true);
  });

  test("batch export records server-reported failures without aborting", async () => {
    // Some posts succeed, some fail — batch must still write the successful
    // ones and report the failures via the JSON summary.
    const zip = new JSZip();
    const pdfA = Buffer.from("PDF-A");
    zip.file("a.pdf", pdfA);
    const manifest = {
      format: "pdf" as const,
      results: [
        {
          postId: "p1",
          success: true as const,
          slug: "a",
          filename: "a.pdf",
          bytes: pdfA.length,
        },
        {
          postId: "p2",
          success: false as const,
          error: "not_found",
          message: "p2 not found",
        },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
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
      ["--json", "export", "p1", "p2", "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    // Partial success: exit code still 0 (matches API behaviour).
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(result.cwd, "a.pdf"))).toBe(true);
    const body = result.json<{ succeeded: number; failed: number; results: Array<{ success: boolean; error?: string }> }>();
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((r) => !r.success)?.error).toBe("not_found");
  });

  test("batch export errors when the server forgets the manifest header", async () => {
    // Defensive: without the manifest header we can't map files, so bail.
    api.on("POST", "/api/v1/posts/batch/export", (_req, res) => {
      respondBinary(res, Buffer.from("ZIPDATA"), {
        contentType: "application/zip",
        filename: "batch.zip",
      });
    });
    const result = await run(
      ["--json", "export", "p1", "p2", "--format", "pdf"],
      {
        apiUrl: api.url,
        config: { apiKey: "od_live_x", apiUrl: api.url },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "missing_manifest" });
  });
});
