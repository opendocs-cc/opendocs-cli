import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_IDS,
  installSkillFolder,
  isAgentDetected,
  normalizeAgentId,
  resolveAgents,
  type AgentEnv,
} from "../../src/lib/agent-skills.js";

function byId(ctx: AgentEnv) {
  return Object.fromEntries(resolveAgents(ctx).map((a) => [a.id, a]));
}

describe("agent skills folders", () => {
  test("macOS / Linux defaults", () => {
    const agents = byId({ home: "/home/u", env: {}, platform: "linux" });

    expect(agents["claude-code"]).toMatchObject({ skillsDir: "/home/u/.claude/skills", detectPaths: ["/home/u/.claude"] });
    expect(agents.codex).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.codex"] });
    expect(agents.cursor).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.cursor"] });
    expect(agents["github-copilot"]).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.copilot"] });
    expect(agents["gemini-cli"]).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.gemini"] });
    expect(agents.opencode).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.config/opencode"] });
    expect(agents.cline).toMatchObject({ skillsDir: "/home/u/.cline/skills", detectPaths: ["/home/u/.cline"] });
    expect(agents.openclaw).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.openclaw"] });
    expect(agents["hermes-agent"]).toMatchObject({ skillsDir: "/home/u/.hermes/skills", detectPaths: ["/home/u/.hermes"] });
    expect(agents.windsurf).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.codeium/windsurf"] });
    expect(agents.amp).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.config/amp"] });
    expect(agents.goose).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.config/goose"] });
    expect(agents["kiro-cli"]).toMatchObject({ skillsDir: "/home/u/.kiro/skills", detectPaths: ["/home/u/.kiro"] });
    expect(agents.grok).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/home/u/.grok"] });
  });

  test("Windows uses the user profile, %LOCALAPPDATA% for Hermes and %APPDATA% for Goose", () => {
    const agents = byId({
      home: "C:\\Users\\u",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      platform: "win32",
    });

    expect(agents["claude-code"].skillsDir).toBe("C:\\Users\\u\\.claude\\skills");
    expect(agents.codex.skillsDir).toBe("C:\\Users\\u\\.agents\\skills");
    expect(agents["hermes-agent"]).toMatchObject({
      skillsDir: "C:\\Users\\u\\AppData\\Local\\hermes\\skills",
      detectPaths: ["C:\\Users\\u\\AppData\\Local\\hermes"],
    });
    expect(agents.goose.detectPaths).toEqual(["C:\\Users\\u\\AppData\\Roaming\\Block\\goose"]);
    expect(agents.opencode.detectPaths).toEqual(["C:\\Users\\u\\.config\\opencode"]);
  });

  test("honours the agents' home overrides", () => {
    const agents = byId({
      home: "/home/u",
      env: {
        CLAUDE_CONFIG_DIR: "/cfg/claude",
        CODEX_HOME: "/cfg/codex",
        COPILOT_HOME: "/cfg/copilot",
        GEMINI_CLI_HOME: "/cfg/gemini-home",
        OPENCLAW_STATE_DIR: "/cfg/openclaw",
        HERMES_HOME: "/cfg/hermes",
        KIRO_HOME: "/cfg/kiro",
        GROK_HOME: "/cfg/grok",
        XDG_CONFIG_HOME: "/xdg",
      },
      platform: "darwin",
    });

    expect(agents["claude-code"]).toMatchObject({ skillsDir: "/cfg/claude/skills", detectPaths: ["/cfg/claude"] });
    expect(agents.codex).toMatchObject({ skillsDir: "/home/u/.agents/skills", detectPaths: ["/cfg/codex"] });
    expect(agents["github-copilot"].detectPaths).toEqual(["/cfg/copilot"]);
    expect(agents["gemini-cli"]).toMatchObject({
      skillsDir: "/cfg/gemini-home/.gemini/skills",
      detectPaths: ["/cfg/gemini-home/.gemini"],
    });
    expect(agents.openclaw).toMatchObject({ skillsDir: "/cfg/openclaw/skills", detectPaths: ["/cfg/openclaw"] });
    expect(agents["hermes-agent"].skillsDir).toBe("/cfg/hermes/skills");
    expect(agents["kiro-cli"].skillsDir).toBe("/cfg/kiro/skills");
    expect(agents.grok.detectPaths).toEqual(["/cfg/grok"]);
    expect(agents.opencode.detectPaths).toEqual(["/xdg/opencode"]);
    expect(agents.amp.detectPaths).toEqual(["/xdg/amp", "/home/u/.config/amp"]);
  });

  test("ids and aliases", () => {
    expect(AGENT_IDS).toHaveLength(14);
    expect(normalizeAgentId("claude")).toBe("claude-code");
    expect(normalizeAgentId("Copilot")).toBe("github-copilot");
    expect(normalizeAgentId("gemini")).toBe("gemini-cli");
    expect(normalizeAgentId("kiro")).toBe("kiro-cli");
    expect(normalizeAgentId("hermes")).toBe("hermes-agent");
    expect(normalizeAgentId("vim")).toBeUndefined();
  });
});

describe("installSkillFolder", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-skill-"));
    dirs.push(dir);
    return dir;
  };
  const files = [
    { path: "SKILL.md", content: "---\nname: opendocs\n---\n" },
    { path: "scripts/opendocs.sh", content: "#!/usr/bin/env bash\n", executable: true },
  ];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("installed, then unchanged, then updated", () => {
    const dir = path.join(tmp(), "opendocs");

    expect(installSkillFolder(dir, files)).toEqual({ ok: true, status: "installed" });
    expect(installSkillFolder(dir, files)).toEqual({ ok: true, status: "unchanged" });
    fs.writeFileSync(path.join(dir, "scripts", "opendocs.sh"), "changed");
    expect(installSkillFolder(dir, files)).toEqual({ ok: true, status: "updated" });
    expect(fs.readFileSync(path.join(dir, "scripts", "opendocs.sh"), "utf8")).toBe("#!/usr/bin/env bash\n");
  });

  test.skipIf(process.platform === "win32")("restores a lost executable bit", () => {
    const dir = path.join(tmp(), "opendocs");
    installSkillFolder(dir, files);
    const script = path.join(dir, "scripts", "opendocs.sh");
    fs.chmodSync(script, 0o644);

    expect(installSkillFolder(dir, files)).toEqual({ ok: true, status: "updated" });
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });

  test("leaves a symlinked SKILL.md alone", () => {
    const root = tmp();
    const dir = path.join(root, "opendocs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "real.md"), "real");
    fs.symlinkSync(path.join(root, "real.md"), path.join(dir, "SKILL.md"));

    expect(installSkillFolder(dir, files)).toMatchObject({ ok: false, reason: "symlink" });
    expect(fs.readFileSync(path.join(root, "real.md"), "utf8")).toBe("real");
    expect(fs.existsSync(path.join(dir, "scripts"))).toBe(false);
  });

  test("refuses a file where the folder should be", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "opendocs"), "a file");

    expect(installSkillFolder(path.join(root, "opendocs"), files)).toMatchObject({
      ok: false,
      reason: "not_a_folder",
    });
  });

  test("isAgentDetected checks the agent's home folders", () => {
    const home = tmp();
    const [claude] = resolveAgents({ home, env: {}, platform: process.platform });
    expect(isAgentDetected(claude)).toBe(false);
    fs.mkdirSync(path.join(home, ".claude"));
    expect(isAgentDetected(claude)).toBe(true);
  });
});
