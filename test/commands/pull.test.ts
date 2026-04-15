import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs pull` downloads the raw markdown of a post. Two output modes:
 *   - default: write to `<slug>.md` or --output <path>
 *   - --stdout: emit the markdown on stdout (for piping)
 *
 * We care that both paths work AND that --stdout stays pure text when
 * combined with --json (the --json path should suppress the stdout write
 * so the JSON object isn't contaminated by the markdown body).
 */

describe("commands: pull", () => {
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

  const markdown = "# Pulled\n\nSome body.\n";

  test("pull writes markdown to <slug>.md by default", async () => {
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown,
        title: "Pulled",
        slug: "pulled-slug",
        versionNumber: 1,
      });
    });
    const result = await run(["pull", "post_1"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    const outPath = path.join(result.cwd, "pulled-slug.md");
    expect(fs.readFileSync(outPath, "utf8")).toBe(markdown);
  });

  test("pull -o <path> honours explicit output location", async () => {
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown,
        title: "T",
        slug: "s",
        versionNumber: 1,
      });
    });
    const result = await run(["pull", "post_1", "-o", "out.md"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    const outPath = path.join(result.cwd, "out.md");
    expect(fs.readFileSync(outPath, "utf8")).toBe(markdown);
  });

  test("pull --stdout emits raw markdown on stdout (no file write)", async () => {
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown,
        title: "T",
        slug: "s",
        versionNumber: 1,
      });
    });
    const result = await run(["pull", "post_1", "--stdout"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(markdown);
    // No file should have been written.
    expect(fs.existsSync(path.join(result.cwd, "s.md"))).toBe(false);
  });

  test("pull --json --stdout emits ONLY the JSON payload (not the body)", async () => {
    // Important: the --json path must NOT mix a markdown body into the
    // stdout stream — otherwise consumers that JSON.parse stdout break.
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown,
        title: "T",
        slug: "s",
        versionNumber: 1,
      });
    });
    const result = await run(["--json", "pull", "post_1", "--stdout"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({ markdown, slug: "s" });
  });

  test("pull surfaces 404 for a missing post", async () => {
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, { error: "not_found", message: "gone" }, 404);
    });
    const result = await run(["--json", "pull", "nope"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "not_found" });
  });
});
