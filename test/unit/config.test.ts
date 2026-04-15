import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, saveConfig, clearConfig } from "../../src/lib/config.js";

/**
 * Unit coverage for src/lib/config.ts. All exported functions read
 * XDG_CONFIG_HOME at call time (not at import), so flipping the env var
 * between tests is enough — no module reload needed.
 *
 * What we care about:
 *   1. XDG_CONFIG_HOME is respected (the rest of the test suite depends on it).
 *   2. saveConfig writes with mode 0o600 — sensitive, API key on disk.
 *   3. loadConfig round-trips the shape and survives malformed input.
 *   4. clearConfig is idempotent so logout never throws.
 */

describe("lib/config", () => {
  let xdgHome: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-config-test-"));
    process.env.XDG_CONFIG_HOME = xdgHome;
  });

  afterEach(() => {
    fs.rmSync(xdgHome, { recursive: true, force: true });
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  test("loadConfig returns null when no config exists", () => {
    expect(loadConfig()).toBeNull();
  });

  test("saveConfig + loadConfig round-trip preserves full shape", () => {
    const payload = {
      apiKey: "od_live_abc123",
      apiUrl: "https://api.opendocs.cc",
      userId: "user_1",
      username: "alice",
      workspaceId: "ws_1",
      workspaceName: "Alice's Workspace",
    };
    saveConfig(payload);
    expect(loadConfig()).toEqual(payload);
  });

  test("saveConfig writes file with 0600 perms (sensitive API key)", () => {
    saveConfig({ apiKey: "od_live_secret", apiUrl: "https://api.opendocs.cc" });
    const filePath = path.join(xdgHome, "opendocs", "config.json");
    const stat = fs.statSync(filePath);
    // Skip on Windows — POSIX perms don't apply. CI runs on Linux/Mac so this
    // is a first-class assertion in practice.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  test("saveConfig creates nested config directory if missing", () => {
    saveConfig({ apiKey: "od_live_abc", apiUrl: "https://api.opendocs.cc" });
    expect(fs.existsSync(path.join(xdgHome, "opendocs", "config.json"))).toBe(true);
  });

  test("saveConfig overwrites existing config (re-login flow)", () => {
    saveConfig({ apiKey: "od_live_old", apiUrl: "https://api.opendocs.cc" });
    saveConfig({ apiKey: "od_live_new", apiUrl: "https://api.opendocs.cc" });
    expect(loadConfig()?.apiKey).toBe("od_live_new");
  });

  test("clearConfig is idempotent — runs cleanly with no file present", () => {
    // Call twice; second call must not throw even though the file is gone.
    expect(() => {
      clearConfig();
      clearConfig();
    }).not.toThrow();
  });

  test("clearConfig removes the saved config", () => {
    saveConfig({ apiKey: "od_live_x", apiUrl: "https://api.opendocs.cc" });
    expect(loadConfig()).not.toBeNull();
    clearConfig();
    expect(loadConfig()).toBeNull();
  });

  test("loadConfig returns null on malformed JSON (not an exception)", () => {
    const dir = path.join(xdgHome, "opendocs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json");
    expect(loadConfig()).toBeNull();
  });
});
