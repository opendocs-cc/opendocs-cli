import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
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

  test("pull --project pulls every document in the active project", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          {
            id: "proj_active",
            workspaceId: "ws_1",
            name: "Launch",
            slug: "launch",
            isDefault: false,
            postCount: 2,
            updatedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
        defaultProject: null,
      });
    });
    api.on("GET", "/api/v1/posts", (req, res) => {
      expect(req.query.get("workspaceId")).toBe("ws_1");
      expect(req.query.get("projectId")).toBe("proj_active");
      respondJson(res, {
        posts: [
          post({ id: "post_a", slug: "alpha", projectId: "proj_active", projectSlug: "launch" }),
          post({ id: "post_b", slug: "beta", projectId: "proj_active", projectSlug: "launch" }),
        ],
        pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
      });
    });
    api.on("GET", "/api/v1/posts/:postId/raw", (req, res) => {
      respondJson(res, {
        markdown: `# ${req.params.postId}\n`,
        title: req.params.postId,
        slug: req.params.postId === "post_a" ? "alpha" : "beta",
        projectId: "proj_active",
        projectSlug: "launch",
        projectName: "Launch",
        isDefaultProject: false,
        versionNumber: 1,
      });
    });

    const result = await run(["pull", "--project", "-o", "pulled"], {
      apiUrl: api.url,
      config: {
        apiKey: "od_live_x",
        apiUrl: api.url,
        workspaceId: "ws_1",
        projectId: "proj_active",
        projectSlug: "launch",
        projectName: "Launch",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(result.cwd, "pulled", "alpha.md"), "utf8")).toBe("# post_a\n");
    expect(fs.readFileSync(path.join(result.cwd, "pulled", "beta.md"), "utf8")).toBe("# post_b\n");
  });

  test("pull --project <slug> --tag resolves the project and forwards tag", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          {
            id: "proj_launch",
            workspaceId: "ws_1",
            name: "Launch",
            slug: "launch",
            isDefault: false,
            postCount: 1,
            updatedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
        defaultProject: null,
      });
    });
    api.on("GET", "/api/v1/posts", (req, res) => {
      expect(req.query.get("projectId")).toBe("proj_launch");
      expect(req.query.get("tag")).toBe("release");
      respondJson(res, {
        posts: [
          post({ id: "post_release", slug: "release-plan", projectId: "proj_launch", projectSlug: "launch" }),
        ],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
    });
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown: "# Release\n",
        title: "Release",
        slug: "release-plan",
        projectId: "proj_launch",
        projectSlug: "launch",
        projectName: "Launch",
        isDefaultProject: false,
        versionNumber: 1,
      });
    });

    const result = await run(["pull", "--project", "launch", "--tag", "release", "-o", "tagged"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(result.cwd, "tagged", "release-plan.md"), "utf8")).toBe("# Release\n");
  });

  test("pull --workspace groups non-default projects under projects/<slug>", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          {
            id: "proj_default",
            workspaceId: "ws_1",
            name: "Default",
            slug: "default",
            isDefault: true,
            postCount: 1,
            updatedAt: "2026-04-26T00:00:00.000Z",
          },
          {
            id: "proj_client",
            workspaceId: "ws_1",
            name: "Client",
            slug: "client-work",
            isDefault: false,
            postCount: 1,
            updatedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
        defaultProject: null,
      });
    });
    api.on("GET", "/api/v1/posts", (req, res) => {
      const projectId = req.query.get("projectId");
      respondJson(res, {
        posts:
          projectId === "proj_default"
            ? [post({ id: "post_default", slug: "home", projectId: "proj_default", projectSlug: "default", isDefaultProject: true })]
            : [post({ id: "post_client", slug: "home", projectId: "proj_client", projectSlug: "client-work" })],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
    });
    api.on("GET", "/api/v1/posts/:postId/raw", (req, res) => {
      respondJson(res, {
        markdown: `# ${req.params.postId}\n`,
        title: req.params.postId,
        slug: "home",
        projectId: req.params.postId === "post_default" ? "proj_default" : "proj_client",
        projectSlug: req.params.postId === "post_default" ? "default" : "client-work",
        projectName: req.params.postId === "post_default" ? "Default" : "Client",
        isDefaultProject: req.params.postId === "post_default",
        versionNumber: 1,
      });
    });

    const result = await run(["pull", "--workspace", "-o", "workspace"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" },
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(result.cwd, "workspace", "home.md"), "utf8")).toBe("# post_default\n");
    expect(
      fs.readFileSync(path.join(result.cwd, "workspace", "projects", "client-work", "home.md"), "utf8"),
    ).toBe("# post_client\n");
  });

  test("bulk pull refuses to overwrite existing files unless --overwrite is passed", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          {
            id: "proj_active",
            workspaceId: "ws_1",
            name: "Default",
            slug: "default",
            isDefault: true,
            postCount: 1,
            updatedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
        defaultProject: null,
      });
    });
    api.on("GET", "/api/v1/posts", (_req, res) => {
      respondJson(res, {
        posts: [
          post({ id: "post_existing", slug: "existing", projectId: "proj_active", projectSlug: "default", isDefaultProject: true }),
        ],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
    });
    api.on("GET", "/api/v1/posts/:postId/raw", (_req, res) => {
      respondJson(res, {
        markdown: "# New\n",
        title: "Existing",
        slug: "existing",
        projectId: "proj_active",
        projectSlug: "default",
        projectName: "Default",
        isDefaultProject: true,
        versionNumber: 1,
      });
    });

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-pull-overwrite-"));
    const outDir = path.join("existing-dir");
    fs.mkdirSync(path.join(cwd, outDir));
    fs.writeFileSync(path.join(cwd, outDir, "existing.md"), "# Old\n");

    const refused = await run(["--json", "pull", "--project", "-o", outDir], {
      apiUrl: api.url,
      cwd,
      config: {
        apiKey: "od_live_x",
        apiUrl: api.url,
        workspaceId: "ws_1",
        projectId: "proj_active",
      },
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: "file_exists" });
    expect(fs.readFileSync(path.join(cwd, outDir, "existing.md"), "utf8")).toBe("# Old\n");

    const overwritten = await run(["pull", "--project", "-o", outDir, "--overwrite"], {
      apiUrl: api.url,
      cwd,
      config: {
        apiKey: "od_live_x",
        apiUrl: api.url,
        workspaceId: "ws_1",
        projectId: "proj_active",
      },
    });
    expect(overwritten.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(cwd, outDir, "existing.md"), "utf8")).toBe("# New\n");
  });
});

function post(overrides: Partial<{
  id: string;
  slug: string;
  projectId: string;
  projectSlug: string;
  isDefaultProject: boolean;
}> = {}) {
  return {
    id: overrides.id ?? "post_1",
    slug: overrides.slug ?? "doc",
    title: "Doc",
    summary: null,
    visibility: "workspace",
    isPublished: true,
    updatedAt: "2026-04-26T00:00:00.000Z",
    tags: [],
    workspaceId: "ws_1",
    workspaceSlug: "acme",
    projectId: overrides.projectId ?? "proj_1",
    projectSlug: overrides.projectSlug ?? "default",
    projectName: "Project",
    isDefaultProject: overrides.isDefaultProject ?? false,
  };
}
