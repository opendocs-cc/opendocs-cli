import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_SKILL = fs.readFileSync(path.join(CLI_ROOT, "agent", "SKILL.md"), "utf8");
const BUNDLED_SCRIPT = fs.readFileSync(path.join(CLI_ROOT, "agent", "scripts", "opendocs.sh"), "utf8");

type InstallJson = {
  installed: { agent: string; path: string; status: string }[];
  skipped: { agent: string; reason: string; path?: string; message?: string }[];
  version: string;
};

describe("commands: agent --install", () => {
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;
  let home: string;

  // Runs the CLI with a temp HOME and only the env vars the test sets, so the
  // real ~/.claude, ~/.agents, CODEX_HOME etc. are never read or written.
  const cli = (args: string[]) =>
    run(args, { env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") } });
  const mkdir = (...parts: string[]) => fs.mkdirSync(path.join(home, ...parts), { recursive: true });
  const skillPath = (...parts: string[]) => path.join(home, ...parts, "opendocs");

  beforeEach(() => {
    harness = makeRunCli();
    run = harness.run;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-home-")));
  });

  afterEach(() => {
    harness.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("installs SKILL.md and an executable scripts/opendocs.sh for detected agents only", async () => {
    mkdir(".claude");
    mkdir(".codex");
    mkdir(".cursor");
    mkdir(".kiro");

    const result = await cli(["--json", "agent", "--install"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<InstallJson>();
    expect(json.version).toEqual(expect.any(String));
    expect(json.installed).toEqual([
      { agent: "claude-code", path: skillPath(".claude", "skills"), status: "installed" },
      // Codex and Cursor share ~/.agents/skills: written once, listed for both.
      { agent: "codex", path: skillPath(".agents", "skills"), status: "installed" },
      { agent: "cursor", path: skillPath(".agents", "skills"), status: "installed" },
      { agent: "kiro-cli", path: skillPath(".kiro", "skills"), status: "installed" },
    ]);
    const notDetected = json.skipped.filter((s) => s.reason === "not_detected").map((s) => s.agent);
    expect(notDetected).toContain("github-copilot");
    expect(notDetected).toContain("cline");
    expect(notDetected).not.toContain("claude-code");

    for (const dir of [skillPath(".claude", "skills"), skillPath(".agents", "skills"), skillPath(".kiro", "skills")]) {
      expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(BUNDLED_SKILL);
      const script = path.join(dir, "scripts", "opendocs.sh");
      expect(fs.readFileSync(script, "utf8")).toBe(BUNDLED_SCRIPT);
      if (process.platform !== "win32") {
        expect(fs.statSync(script).mode & 0o111).not.toBe(0);
      }
    }
    // Nothing for agents that aren't there.
    expect(fs.existsSync(path.join(home, ".cline"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".hermes"))).toBe(false);
  });

  test("human output lists agent, path and status, then the agents not found", async () => {
    mkdir(".claude");

    const result = await cli(["agent", "--install"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Claude Code\s+~\/\.claude\/skills\/opendocs\s+installed/);
    expect(result.stdout).toMatch(/Not found: .*Codex.*Cursor/);
  });

  test("re-running is idempotent and reports unchanged", async () => {
    mkdir(".claude");
    mkdir(".gemini");

    await cli(["agent", "--install"]);
    const skillFile = path.join(skillPath(".claude", "skills"), "SKILL.md");
    const before = fs.statSync(skillFile).mtimeMs;

    const again = await cli(["--json", "agent", "--install"]);

    expect(again.exitCode).toBe(0);
    expect(again.json<InstallJson>().installed.map((e) => e.status)).toEqual(["unchanged", "unchanged"]);
    expect(fs.statSync(skillFile).mtimeMs).toBe(before);
    expect(fs.readdirSync(skillPath(".claude", "skills")).sort()).toEqual(["SKILL.md", "scripts"]);
  });

  test("updates changed files, keeps files it didn't write", async () => {
    mkdir(".claude", "skills", "opendocs", "bin");
    fs.writeFileSync(path.join(skillPath(".claude", "skills"), "SKILL.md"), "old\n");
    fs.writeFileSync(path.join(skillPath(".claude", "skills"), "bin", "jq"), "jq binary");

    const result = await cli(["--json", "agent", "--install"]);

    expect(result.json<InstallJson>().installed).toEqual([
      { agent: "claude-code", path: skillPath(".claude", "skills"), status: "updated" },
    ]);
    expect(fs.readFileSync(path.join(skillPath(".claude", "skills"), "SKILL.md"), "utf8")).toBe(BUNDLED_SKILL);
    expect(fs.readFileSync(path.join(skillPath(".claude", "skills"), "bin", "jq"), "utf8")).toBe("jq binary");
  });

  test("--agent installs for named agents even when not detected", async () => {
    const result = await cli(["--json", "agent", "--install", "--agent", "cline", "hermes"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<InstallJson>();
    expect(json.installed).toEqual([
      { agent: "cline", path: skillPath(".cline", "skills"), status: "installed" },
      { agent: "hermes-agent", path: skillPath(".hermes", "skills"), status: "installed" },
    ]);
    expect(json.skipped).toEqual([]);
    expect(fs.existsSync(path.join(skillPath(".cline", "skills"), "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillPath(".hermes", "skills"), "scripts", "opendocs.sh"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
  });

  test("--agent works without --install and accepts comma-separated ids", async () => {
    const result = await cli(["--json", "agent", "--agent", "claude-code,codex"]);

    expect(result.exitCode).toBe(0);
    expect(result.json<InstallJson>().installed.map((e) => e.agent)).toEqual(["claude-code", "codex"]);
  });

  test("--agent rejects unknown ids", async () => {
    const result = await cli(["--json", "agent", "--install", "--agent", "notepad"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "unknown_agent",
      message: expect.stringContaining("claude-code"),
    });
  });

  test("--list shows every agent, its folder and whether it's detected, without installing", async () => {
    mkdir(".cursor");

    const result = await cli(["--json", "agent", "--list"]);

    expect(result.exitCode).toBe(0);
    const { agents } = result.json<{ agents: { agent: string; path: string; detected: boolean }[] }>();
    expect(agents.map((a) => a.agent)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "github-copilot",
      "gemini-cli",
      "opencode",
      "cline",
      "openclaw",
      "hermes-agent",
      "windsurf",
      "amp",
      "goose",
      "kiro-cli",
      "grok",
    ]);
    expect(agents.find((a) => a.agent === "cursor")).toEqual({
      agent: "cursor",
      name: "Cursor",
      path: skillPath(".agents", "skills"),
      detected: true,
    });
    expect(agents.find((a) => a.agent === "claude-code")?.detected).toBe(false);
    expect(fs.existsSync(path.join(home, ".agents"))).toBe(false);

    const human = await cli(["agent", "--list"]);
    expect(human.stdout).toMatch(/Cursor\s+cursor\s+~\/\.agents\/skills\/opendocs\s+yes/);
    expect(human.stdout).toMatch(/Claude Code\s+claude-code\s+~\/\.claude\/skills\/opendocs\s+no/);
  });

  test("skips a skill folder that is a symlink and reports it", async () => {
    mkdir(".claude", "skills");
    mkdir(".codex");
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "mine\n");
    fs.symlinkSync(elsewhere, skillPath(".claude", "skills"), "dir");

    const result = await cli(["--json", "agent", "--install"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<InstallJson>();
    expect(json.installed).toEqual([
      { agent: "codex", path: skillPath(".agents", "skills"), status: "installed" },
    ]);
    expect(json.skipped).toContainEqual(
      expect.objectContaining({
        agent: "claude-code",
        reason: "symlink",
        path: skillPath(".claude", "skills"),
        message: expect.stringContaining(elsewhere),
      }),
    );
    expect(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(elsewhere, "scripts"))).toBe(false);
  });

  test("skips a skill folder whose scripts/ is a symlink", async () => {
    mkdir(".claude", "skills", "opendocs");
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(skillPath(".claude", "skills"), "scripts"), "dir");

    const result = await cli(["--json", "agent", "--install"]);

    const json = result.json<InstallJson>();
    expect(json.installed).toEqual([]);
    expect(json.skipped).toContainEqual(expect.objectContaining({ agent: "claude-code", reason: "symlink" }));
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.existsSync(path.join(skillPath(".claude", "skills"), "SKILL.md"))).toBe(false);
  });

  test("a symlinked skills folder shared with another agent is written once", async () => {
    mkdir(".agents", "skills");
    mkdir(".claude");
    mkdir(".codex");
    fs.symlinkSync(path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills"), "dir");

    const result = await cli(["--json", "agent", "--install"]);

    expect(result.json<InstallJson>().installed).toEqual([
      { agent: "claude-code", path: skillPath(".claude", "skills"), status: "installed" },
      { agent: "codex", path: skillPath(".agents", "skills"), status: "installed" },
    ]);
  });

  test("--install <dir> still installs into that folder", async () => {
    const dir = path.join(home, "custom", "opendocs");

    const result = await cli(["--json", "agent", "--install", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.json<InstallJson>()).toMatchObject({
      installed: [{ agent: "custom", path: dir, status: "installed" }],
      skipped: [],
    });
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(BUNDLED_SKILL);
    expect(fs.existsSync(path.join(dir, "scripts", "opendocs.sh"))).toBe(true);
  });

  test("--install <dir> and --agent conflict", async () => {
    const result = await cli(["--json", "agent", "--install", path.join(home, "x"), "--agent", "codex"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "conflicting_options" });
  });

  test("no detected agents installs nothing and says how to pick one", async () => {
    const result = await cli(["agent", "--install"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No supported agents found");
    expect(result.stdout).toContain("--agent <id>");
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
