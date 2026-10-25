import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";
import { makeRunCli, readCliConfig, type RunCli } from "../helpers/run-cli.js";

describe("commands: project", () => {
  let api: MockApi;
  let run: RunCli;
  let harness: ReturnType<typeof makeRunCli>;

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  const config = {
    apiKey: "od_live_x",
    workspaceId: "ws_1",
    workspaceName: "Acme",
    workspaceSlug: "acme",
    projectId: "proj_default",
    projectName: "Default",
    projectSlug: "default",
  };

  it("project use stores the active project", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          { id: "proj_default", workspaceId: "ws_1", name: "Default", slug: "default", isDefault: true, postCount: 1 },
          { id: "proj_launch", workspaceId: "ws_1", name: "Launch", slug: "launch", isDefault: false, postCount: 0 },
        ],
        defaultProject: null,
      });
    });

    const result = await run(["--json", "project", "use", "launch"], {
      apiUrl: api.url,
      config,
    });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      success: true,
      project: { id: "proj_launch", slug: "launch", name: "Launch" },
    });
    expect(readCliConfig(harness.configDir)).toMatchObject({
      projectId: "proj_launch",
      projectName: "Launch",
      projectSlug: "launch",
    });
  });

  it("project create --use persists the new project", async () => {
    api.on("POST", "/api/v1/projects", (req, res) => {
      expect(req.body).toMatchObject({
        workspaceId: "ws_1",
        name: "Launch docs",
        slug: "launch-docs",
      });
      respondJson(
        res,
        {
          project: {
            id: "proj_launch",
            workspaceId: "ws_1",
            name: "Launch docs",
            slug: "launch-docs",
            isDefault: false,
          },
        },
        201,
      );
    });

    const result = await run(
      ["--json", "project", "create", "Launch docs", "--slug", "launch-docs", "--use"],
      { apiUrl: api.url, config },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      active: true,
      project: { id: "proj_launch", slug: "launch-docs" },
    });
    expect(readCliConfig(harness.configDir)).toMatchObject({
      projectId: "proj_launch",
      projectName: "Launch docs",
      projectSlug: "launch-docs",
    });
  });

  it("whoami includes active project in JSON", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "usr_1",
        onboarding: {
          username: "ada",
          workspace: { id: "ws_1", name: "Acme", slug: "acme" },
        },
        quota: { documents: null },
      });
    });
    api.on("GET", "/api/v1/workspaces", (_req, res) => {
      respondJson(res, {
        workspaces: [{ id: "ws_1", name: "Acme", slug: "acme", role: "owner" }],
      });
    });

    const result = await run(["--json", "whoami"], { apiUrl: api.url, config });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      project: { id: "proj_default", name: "Default", slug: "default" },
    });
  });

  it("project delete refuses without --yes outside a terminal (confirm_required)", async () => {
    const result = await run(["--json", "project", "delete", "launch"], { apiUrl: api.url, config });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "confirm_required" });
    expect(api.calls).toHaveLength(0);
  });

  it("project delete -y deletes the project", async () => {
    api.on("GET", "/api/v1/projects", (_req, res) => {
      respondJson(res, {
        projects: [
          { id: "proj_default", workspaceId: "ws_1", name: "Default", slug: "default", isDefault: true, postCount: 1 },
          { id: "proj_launch", workspaceId: "ws_1", name: "Launch", slug: "launch", isDefault: false, postCount: 0 },
        ],
        defaultProject: null,
      });
    });
    api.on("DELETE", "/api/v1/projects/:projectId", (req, res) => {
      respondJson(res, { deleted: true, projectId: req.params.projectId });
    });

    const result = await run(["--json", "project", "delete", "launch", "-y"], { apiUrl: api.url, config });

    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual({ deleted: true, projectId: "proj_launch" });
  });
});
