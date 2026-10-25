import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  makeRunCli,
  readCliConfig,
  cliConfigPath,
  type RunCli,
} from "../helpers/run-cli.js";
import { startMockApi, respondJson, type MockApi } from "../helpers/mock-api.js";

/**
 * Covers the three auth lifecycle commands as a group:
 *   - login  (validates key, writes config)
 *   - whoami (reads config, re-validates against /me)
 *   - logout (clears config)
 *
 * These share the same setup (mock API + sandbox config dir) so they live in
 * one file. Each test exercises the real subprocess so commander parsing,
 * process.exit, and config I/O all run the same way they would in production.
 */

describe("commands: login / whoami / logout", () => {
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

  // ── login ─────────────────────────────────────────────────────────────

  test("login --json persists config after successful /me check", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "user_123",
        onboarding: {
          username: "alice",
          workspace: { id: "ws_1", name: "Alice Workspace" },
        },
      });
    });

    const result = await run(
      ["--json", "login", "--key", "od_live_validkey"],
      { apiUrl: api.url },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      success: true,
      username: "alice",
      workspaceId: "ws_1",
    });

    const cfg = readCliConfig(harness.configDir) as { apiKey: string };
    expect(cfg?.apiKey).toBe("od_live_validkey");
    // Check file perms match the expectation config.test.ts enforces.
    if (process.platform !== "win32") {
      const stat = fs.statSync(cliConfigPath(harness.configDir));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  test("login accepts OPENDOCS_API_KEY env var (no --key flag)", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "u",
        onboarding: { username: "envu", workspace: { id: "w", name: "W" } },
      });
    });

    const result = await run(["--json", "login"], {
      apiUrl: api.url,
      env: { OPENDOCS_API_KEY: "od_live_fromenv" },
    });

    expect(result.exitCode).toBe(0);
    expect(api.calls[0].headers.authorization).toBe("Bearer od_live_fromenv");
  });

  test("login rejects keys that do not start with od_live_", async () => {
    const result = await run(
      ["--json", "login", "--key", "sk_wrong_prefix"],
      { apiUrl: api.url },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "invalid_key_format",
    });
    // No network call should have happened yet — this is pre-flight.
    expect(api.calls).toHaveLength(0);
    // Config file must NOT exist.
    expect(readCliConfig(harness.configDir)).toBeNull();
  });

  test("login surfaces 401 from /me as an auth error (config not written)", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, { error: "auth_expired", message: "revoked" }, 401);
    });
    const result = await run(
      ["--json", "login", "--key", "od_live_revoked"],
      { apiUrl: api.url },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "auth_expired" });
    // Must not have written the (invalid) key to disk.
    expect(readCliConfig(harness.configDir)).toBeNull();
  });

  test("login with incomplete onboarding yields a clear error", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "u",
        onboarding: {}, // No username, no workspace
      });
    });
    const result = await run(
      ["--json", "login", "--key", "od_live_nogerms"],
      { apiUrl: api.url },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "onboarding_incomplete",
    });
    expect(readCliConfig(harness.configDir)).toBeNull();
  });

  // ── whoami ─────────────────────────────────────────────────────────────

  test("whoami --json returns server identity when logged in", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, {
        authenticated: true,
        userId: "user_seeded",
        onboarding: {
          username: "seed",
          workspace: { id: "ws_seed", name: "Seeded" },
        },
      });
    });
    const result = await run(["--json", "whoami"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_seeded", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      authenticated: true,
      userId: "user_seeded",
      onboarding: { username: "seed" },
    });
  });

  test("whoami without config exits 1 with login hint", async () => {
    const result = await run(["whoami"], { apiUrl: api.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Not logged in/);
  });

  test("whoami --json without config prints the not_logged_in JSON error", async () => {
    const result = await run(["whoami", "--json"], { apiUrl: api.url });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "not_logged_in",
      message: expect.stringMatching(/Not logged in/),
    });
  });

  test("every signed-in command reports not_logged_in as JSON when signed out", async () => {
    // One invocation per command file that loads the config, so a new
    // command that prints plain text in --json mode shows up here.
    const commands = [
      ["whoami"],
      ["list"],
      ["get", "doc"],
      ["pull", "doc"],
      ["export", "doc"],
      ["update", "doc.md", "--post-id", "doc"],
      ["unpublish", "doc"],
      ["visibility", "doc", "private"],
      ["delete", "doc", "--yes"],
      ["history", "doc"],
      ["rollback", "doc", "1"],
      ["move", "doc", "--project", "x"],
      ["share", "doc"],
      ["invite", "dana@acme.com"],
      ["claim", "token"],
      ["clone"],
      ["status"],
      ["config", "get"],
      ["project", "list"],
      ["project", "delete", "x", "--yes"],
      ["workspace", "list"],
      ["team", "list"],
      ["theme", "show"],
      ["integrations"],
      ["save", "doc", "--folder", "Board Minutes"],
      ["sign", "list"],
    ];
    const results = await Promise.all(
      commands.map((args) => run(["--json", ...args], { apiUrl: api.url })),
    );
    results.forEach((result, i) => {
      const label = commands[i].join(" ");
      expect(result.exitCode, label).toBe(1);
      expect(result.stdout, label).toBe("");
      expect(JSON.parse(result.stderr), label).toMatchObject({ error: "not_logged_in" });
    });
    expect(api.calls).toHaveLength(0);
  });

  test("whoami with 401 surfaces the auth_expired code AND clears config", async () => {
    api.on("GET", "/api/v1/me", (_req, res) => {
      respondJson(res, { error: "auth_expired", message: "revoked" }, 401);
    });
    const result = await run(["--json", "whoami"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_revoked", apiUrl: api.url },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "auth_expired" });
    // Config should be wiped by the 401 side-effect — important UX promise.
    expect(readCliConfig(harness.configDir)).toBeNull();
  });

  // ── logout ─────────────────────────────────────────────────────────────

  test("logout clears the config file", async () => {
    // Seed a config via the harness, then logout removes it.
    const r1 = await run(["--json", "whoami"], {
      apiUrl: api.url,
      config: { apiKey: "od_live_x", apiUrl: api.url },
    });
    // The whoami call may 404 since we didn't stub /me — we don't care; we're
    // testing logout. Just confirm the config was seeded.
    expect(readCliConfig(harness.configDir)).not.toBeNull();
    void r1;

    const result = await run(["--json", "logout"], { apiUrl: api.url });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual({ success: true });
    expect(readCliConfig(harness.configDir)).toBeNull();
  });

  test("logout is safe when no config exists", async () => {
    const result = await run(["--json", "logout"], { apiUrl: api.url });
    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual({ success: true });
  });
});
