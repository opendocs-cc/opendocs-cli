import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * `opendocs integrations` and `opendocs save` against the integrations
 * spec (GET /integrations, POST /posts/:doc/storage). Human output is
 * asserted with colors off (the harness sets NO_COLOR).
 */

const DASHBOARD = "https://opendocs.cc/dashboard/integrations";

function overview(overrides: Record<string, unknown> = {}) {
  return {
    workspace: { id: "ws_1", slug: "acme", name: "Acme" },
    tier: "pro",
    role: "owner",
    canManage: true,
    canUse: true,
    settings: { usableBy: "members", signatureConfirmation: "chat" },
    dashboardUrl: DASHBOARD,
    integrations: [
      {
        provider: "google_drive",
        name: "Google Drive",
        capabilities: ["storage"],
        status: "connected",
        account: "drive@acme.is",
        connectedAt: "2026-10-01T10:00:00.000Z",
        destinations: [
          {
            id: "dst_1",
            name: "Board Minutes",
            folderName: "Stjórnarfundir",
            driveName: "Legal",
            url: "https://drive.google.com/drive/folders/f1",
          },
          {
            id: "dst_2",
            name: "Signed agreements",
            folderName: "Samningar",
            driveName: null,
            url: "https://drive.google.com/drive/folders/f2",
          },
        ],
      },
      {
        provider: "docuseal",
        name: "DocuSeal",
        capabilities: ["signature"],
        status: "not_connected",
        account: null,
        region: null,
        connectedAt: null,
      },
    ] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

const STORAGE_RUN = {
  id: "run_1",
  provider: "google_drive",
  destination: { id: "dst_1", name: "Board Minutes" },
  document: { postId: "p_1", slug: "board-meeting", title: "Board meeting 24 October 2026", versionNumber: 3 },
  file: {
    id: "drive_file_1",
    name: "Board meeting 24 October 2026 (v3).pdf",
    url: "https://drive.google.com/file/d/drive_file_1/view",
    format: "pdf",
    bytes: 81234,
    sha256: "3f2a9c1e04b7d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e",
    driveSha256: "3f2a9c1e04b7d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e",
    verified: true,
  },
};

describe("commands: integrations / save", () => {
  let api: MockApi;
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;
  let opts: { apiUrl: string; config: { apiKey: string; apiUrl: string; workspaceId: string } };

  beforeEach(async () => {
    api = await startMockApi();
    harness = makeRunCli();
    run = harness.run;
    opts = { apiUrl: api.url, config: { apiKey: "od_live_x", apiUrl: api.url, workspaceId: "ws_1" } };
  });

  afterEach(async () => {
    harness.cleanup();
    await api.close();
  });

  // ── integrations ────────────────────────────────────────────────────────

  test("integrations lists providers, folders and settings, with a dashboard hint for what isn't connected", async () => {
    api.on("GET", "/api/v1/integrations", (req, res) => {
      expect(req.query.get("workspaceId")).toBe("ws_1");
      respondJson(res, overview());
    });

    const result = await run(["integrations"], opts);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Integrations for Acme (pro plan, you're the owner):");
    expect(out).toMatch(/Google Drive\s+connected · drive@acme\.is/);
    expect(out).toMatch(/• Board Minutes\s+Legal › Stjórnarfundir/);
    expect(out).toMatch(/• Signed agreements\s+Samningar/);
    expect(out).toMatch(/DocuSeal\s+not connected/);
    expect(out).toMatch(/Who can use\s+every workspace member/);
    expect(out).toMatch(/Signatures\s+sent by the agent after the user confirms in chat/);
    expect(out).toContain("To connect DocuSeal, open the dashboard:");
    // URL on its own line.
    expect(out.split("\n").map((l) => l.trim())).toContain(DASHBOARD);
  });

  test("integrations shows the DocuSeal region, errors and a hint for members who can't manage", async () => {
    api.on("GET", "/api/v1/integrations", (_req, res) => {
      const body = overview({
        role: "member",
        canManage: false,
        canUse: false,
        settings: { usableBy: "admins", signatureConfirmation: "browser" },
      });
      body.integrations[0] = {
        ...body.integrations[0],
        status: "error",
        error: "Google access was revoked. Reconnect Google Drive.",
      };
      body.integrations[1] = {
        ...body.integrations[1],
        status: "connected",
        account: "legal@acme.is",
        region: "eu",
        connectedAt: "2026-10-02T10:00:00.000Z",
      };
      respondJson(res, body);
    });

    const result = await run(["integrations"], opts);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("you're a member");
    expect(out).toContain("Google Drive  needs attention: Google access was revoked. Reconnect Google Drive.");
    expect(out).toMatch(/DocuSeal\s+connected · legal@acme\.is · region eu \(api\.docuseal\.eu\)/);
    expect(out).toMatch(/Who can use\s+owners and admins only/);
    expect(out).toContain("sent by a signed-in person from the browser (API keys can't send)");
    expect(out).toContain("Only owners and admins can save to Drive or request signatures in this workspace.");
    expect(out).toContain("Ask a workspace owner or admin to reconnect Google Drive in the dashboard:");
    expect(out).toContain(DASHBOARD);
  });

  test("integrations prints no dashboard hint when everything is connected and the caller manages it", async () => {
    api.on("GET", "/api/v1/integrations", (_req, res) => {
      const body = overview();
      body.integrations[1] = { ...body.integrations[1], status: "connected", account: "x@y.is", region: "com" };
      respondJson(res, body);
    });
    const result = await run(["integrations"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("region com (api.docuseal.com)");
    expect(result.stdout).not.toContain(DASHBOARD);
  });

  test("integrations --json prints the raw response body", async () => {
    const body = overview();
    api.on("GET", "/api/v1/integrations", (_req, res) => respondJson(res, body));

    const result = await run(["--json", "integrations"], opts);

    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual(body);
  });

  test("integrations on a Free workspace surfaces plan_required with the billing link", async () => {
    api.on("GET", "/api/v1/integrations", (_req, res) =>
      respondJson(res, { error: "plan_required", message: "Integrations are available on Pro and Team plans." }, 403),
    );

    const human = await run(["integrations"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("Integrations are available on Pro and Team plans.");
    expect(human.stderr).toContain("https://opendocs.cc/dashboard/billing");

    const json = await run(["--json", "integrations"], opts);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stderr)).toEqual({
      error: "plan_required",
      message: "Integrations are available on Pro and Team plans.",
    });
  });

  // ── save ────────────────────────────────────────────────────────────────

  test("save POSTs /posts/:doc/storage with folder, format, version and filename", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (req, res) => {
      expect(req.params.postId).toBe("board-meeting");
      expect(req.body).toEqual({
        workspaceId: "ws_1",
        destination: "Board Minutes",
        format: "docx",
        versionNumber: 3,
        filename: "Minutes 2026-10-24",
      });
      respondJson(res, { ...STORAGE_RUN, file: { ...STORAGE_RUN.file, format: "docx" } }, 201);
    });

    // `--version 3` (space-separated) must reach `save`, not print the CLI version.
    const result = await run(
      ["save", "board-meeting", "--folder", "Board Minutes", "--format", "docx", "--version", "3", "--filename", "Minutes 2026-10-24"],
      opts,
    );

    expect(result.exitCode).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  test("save --help says the Drive file is named after the document title", async () => {
    const result = await run(["save", "--help"]);

    expect(result.exitCode).toBe(0);
    // Matches the API (routes/integrations.ts): title plus the format's extension, no version.
    expect(result.stdout.replace(/\s+/g, " ")).toContain("(default: the document title)");
    expect(result.stdout).not.toMatch(/title and version/);
  });

  test("save defaults to PDF and prints the Drive link on its own line, the SHA-256 and the checksum result", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (req, res) => {
      expect(req.body).toEqual({ workspaceId: "ws_1", destination: "board minutes", format: "pdf" });
      respondJson(res, STORAGE_RUN, 201);
    });

    const result = await run(["save", "p_1", "--folder", "board minutes"], opts);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").map((l) => l.trim());
    // The ✔ line comes from the spinner, which writes to stderr.
    expect(result.stderr + result.stdout).toContain("Saved Board meeting 24 October 2026 (v3).pdf to Board Minutes");
    expect(lines).toContain("https://drive.google.com/file/d/drive_file_1/view");
    expect(result.stdout).toContain(`SHA-256: ${STORAGE_RUN.file.sha256}`);
    expect(result.stdout).toContain("Google Drive's checksum matches.");
  });

  test("save warns when Google's checksum doesn't match", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (_req, res) =>
      respondJson(res, { ...STORAGE_RUN, file: { ...STORAGE_RUN.file, driveSha256: "deadbeef", verified: false } }, 201),
    );
    const result = await run(["save", "p_1", "--folder", "Board Minutes"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Google Drive's checksum doesn't match (deadbeef)");
  });

  test("save --json prints the storage run", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (_req, res) => respondJson(res, STORAGE_RUN, 201));
    const result = await run(["--json", "save", "p_1", "--folder", "Board Minutes"], opts);
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual(STORAGE_RUN);
  });

  test("save resolves a local .md file this folder published", async () => {
    const cwd = fs.mkdtempSync(path.join(harness.configDir, "cwd-"));
    fs.writeFileSync(path.join(cwd, "minutes.md"), "# Minutes\n");
    fs.mkdirSync(path.join(cwd, ".opendocs"));
    fs.writeFileSync(
      path.join(cwd, ".opendocs", "state.json"),
      JSON.stringify({
        version: 1,
        docs: {
          "minutes.md": {
            postId: "post_from_state",
            slug: "minutes",
            url: "/acme/minutes",
            workspaceId: "ws_1",
            versionNumber: 1,
            localHash: "x",
            syncedAt: "2026-10-24T00:00:00.000Z",
          },
        },
        anonymous: {},
      }),
    );
    api.on("POST", "/api/v1/posts/:postId/storage", (req, res) => {
      expect(req.params.postId).toBe("post_from_state");
      respondJson(res, STORAGE_RUN, 201);
    });
    const result = await run(["save", "minutes.md", "--folder", "Board Minutes"], { ...opts, cwd });
    expect(result.exitCode).toBe(0);
  });

  test("save rejects an unknown --format and a bad --version before any request", async () => {
    const format = await run(["--json", "save", "p_1", "--folder", "X", "--format", "html"], opts);
    expect(format.exitCode).toBe(1);
    expect(JSON.parse(format.stderr)).toMatchObject({ error: "invalid_format" });

    const version = await run(["--json", "save", "p_1", "--folder", "X", "--version=latest"], opts);
    expect(version.exitCode).toBe(1);
    expect(JSON.parse(version.stderr)).toMatchObject({ error: "invalid_version" });

    expect(api.calls).toHaveLength(0);
  });

  test("save on destination_not_found lists the available folder names", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (_req, res) =>
      respondJson(
        res,
        {
          error: "destination_not_found",
          message: 'No Drive folder named "Minutes" in this workspace.',
          destinations: ["Board Minutes", "Signed agreements"],
        },
        404,
      ),
    );

    const human = await run(["save", "p_1", "--folder", "Minutes"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain('No Drive folder named "Minutes" in this workspace.');
    expect(human.stderr).toContain("Available folders:\n  • Board Minutes\n  • Signed agreements");

    const json = await run(["--json", "save", "p_1", "--folder", "Minutes"], opts);
    expect(JSON.parse(json.stderr)).toEqual({
      error: "destination_not_found",
      message: 'No Drive folder named "Minutes" in this workspace.',
      destinations: ["Board Minutes", "Signed agreements"],
    });
  });

  test("save on integration_not_connected says who can connect it", async () => {
    api.on("POST", "/api/v1/posts/:postId/storage", (_req, res) =>
      respondJson(
        res,
        { error: "integration_not_connected", message: "Google Drive isn't connected.", provider: "google_drive" },
        409,
      ),
    );

    const human = await run(["save", "p_1", "--folder", "Board Minutes"], opts);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("Google Drive isn't connected.");
    expect(human.stderr).toContain("An owner or admin can connect it in the dashboard; `opendocs integrations` shows the link.");

    const json = await run(["--json", "save", "p_1", "--folder", "Board Minutes"], opts);
    expect(JSON.parse(json.stderr)).toEqual({
      error: "integration_not_connected",
      message: "Google Drive isn't connected.",
      provider: "google_drive",
    });
  });

  test("save on reconnect_required and plan_required explains what to do", async () => {
    let code = "reconnect_required";
    api.on("POST", "/api/v1/posts/:postId/storage", (_req, res) =>
      respondJson(res, { error: code, message: `server: ${code}` }, code === "plan_required" ? 403 : 409),
    );

    const reconnect = await run(["save", "p_1", "--folder", "Board Minutes"], opts);
    expect(reconnect.exitCode).toBe(1);
    expect(reconnect.stderr).toContain("server: reconnect_required");
    expect(reconnect.stderr).toContain("needs to reconnect it in the dashboard");

    code = "plan_required";
    const plan = await run(["save", "p_1", "--folder", "Board Minutes"], opts);
    expect(plan.exitCode).toBe(1);
    expect(plan.stderr).toContain("server: plan_required");
    expect(plan.stderr).toContain("Integrations need a Pro or Team plan: https://opendocs.cc/dashboard/billing");
  });
});
