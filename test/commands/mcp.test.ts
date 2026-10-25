import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";

const URL = "https://mcp.opendocs.cc/mcp";
const CLAUDE_ADD = `claude mcp add --transport http --scope user opendocs ${URL}`;

type McpJson = {
  url: string;
  results: { agent: string; name: string; status: string; method: string; path?: string; command?: string; message?: string }[];
  notDetected: string[];
  dryRun?: boolean;
};

// Each run gets a temp HOME and a PATH that holds only `node` and the fake
// programs below, so the real claude / codex / code / open / pbcopy on this
// machine are never found, let alone run. The fakes log their arguments.
const FAKE_CLAUDE = `#!/bin/sh
printf 'claude %s\\n' "$*" >> "$FAKE_LOG"
case "$2" in
  get)
    if [ -n "$FAKE_CLAUDE_GET_URL" ]; then printf 'opendocs:\\n  URL: %s\\n' "$FAKE_CLAUDE_GET_URL"; exit 0; fi
    echo 'No MCP server named "opendocs".' >&2; exit 1 ;;
  add)
    if [ -n "$FAKE_CLAUDE_ADD_ERROR" ]; then echo "$FAKE_CLAUDE_ADD_ERROR" >&2; exit 1; fi
    exit 0 ;;
esac
exit 0
`;
const FAKE_LOGGER = (name: string) => `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$FAKE_LOG"
`;
const FAKE_CLIPBOARD = `#!/bin/sh
/bin/cat > "$FAKE_CLIP"
`;

describe("commands: mcp", () => {
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;
  let home: string;
  let bin: string;
  let log: string;
  let clip: string;

  const cli = (args: string[], env: Record<string, string> = {}) =>
    run(args, {
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        PATH: bin,
        FAKE_LOG: log,
        FAKE_CLIP: clip,
        ...env,
      },
    });
  const mkdir = (...parts: string[]) => fs.mkdirSync(path.join(home, ...parts), { recursive: true });
  const fake = (name: string, script: string) => fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  const logLines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    harness = makeRunCli();
    run = harness.run;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-mcp-cli-")));
    home = path.join(root, "home");
    bin = path.join(root, "bin");
    log = path.join(root, "calls.log");
    clip = path.join(root, "clipboard.txt");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  });

  afterEach(() => {
    harness.cleanup();
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  test("mcp url prints the URL; --json adds the server name", async () => {
    const human = await cli(["mcp", "url"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe(`${URL}\n`);

    const json = await cli(["--json", "mcp", "url"]);
    expect(json.json()).toEqual({ url: URL, name: "opendocs", displayName: "OpenDocs.cc" });
  });

  test("mcp add --json registers in every detected tool", async () => {
    if (process.platform === "win32") return;
    mkdir(".claude");
    mkdir(".cursor");
    mkdir(".codex");
    mkdir(".cline");
    fake("claude", FAKE_CLAUDE);

    const result = await cli(["--json", "mcp", "add"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<McpJson>();
    expect(json.url).toBe(URL);
    expect(json.results).toEqual([
      { agent: "claude-code", name: "Claude Code", status: "added", method: "cli", command: CLAUDE_ADD },
      {
        agent: "codex",
        name: "Codex",
        status: "added",
        method: "config",
        path: path.join(home, ".codex", "config.toml"),
        message: "Sign in with: codex mcp login opendocs",
      },
      { agent: "cursor", name: "Cursor", status: "added", method: "config", path: path.join(home, ".cursor", "mcp.json") },
      {
        agent: "cline",
        name: "Cline",
        status: "manual",
        method: "config",
        message: expect.stringContaining(URL),
      },
    ]);
    expect(json.notDetected).toContain("github-copilot");
    expect(json).not.toHaveProperty("dryRun");

    expect(logLines()).toEqual(["claude mcp get opendocs", `claude ${CLAUDE_ADD.slice("claude ".length)}`]);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: { opendocs: { url: URL } },
    });
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(
      `[mcp_servers.opendocs]\nurl = "${URL}"\n`,
    );
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);

    // Again: nothing left to do.
    const again = await cli(["--json", "mcp", "add", "--agent", "cursor", "codex"], { FAKE_CLAUDE_GET_URL: URL });
    expect(again.json<McpJson>().results.map((r) => r.status)).toEqual(["already_present", "already_present"]);
  });

  test("human output lists each tool and ends with the sign-in line", async () => {
    mkdir(".cursor");
    mkdir(".cline");

    const result = await cli(["mcp", "add"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`OpenDocs MCP server: ${URL}`);
    expect(result.stdout).toMatch(/Cursor\s+added\s+~\/\.cursor\/mcp\.json/);
    expect(result.stdout).toMatch(/Cline\s+manual\s+In Cline's MCP Servers panel/);
    expect(result.stdout).toMatch(/Not found: Claude Code, Codex/);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("Sign in from each tool the first time it uses OpenDocs.");
  });

  test("--dry-run writes nothing and runs nothing but the lookup", async () => {
    if (process.platform === "win32") return;
    mkdir(".claude");
    mkdir(".cursor");
    mkdir(".codex");
    mkdir(".kiro");
    fake("claude", FAKE_CLAUDE);

    const result = await cli(["--json", "mcp", "add", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<McpJson>();
    expect(json.dryRun).toBe(true);
    expect(json.results.map((r) => [r.agent, r.status])).toEqual([
      ["claude-code", "added"],
      ["codex", "added"],
      ["cursor", "added"],
      ["kiro-cli", "added"],
    ]);
    expect(fs.readdirSync(path.join(home, ".cursor"))).toEqual([]);
    expect(fs.readdirSync(path.join(home, ".codex"))).toEqual([]);
    expect(fs.readdirSync(path.join(home, ".kiro"))).toEqual([]);
    expect(logLines()).toEqual(["claude mcp get opendocs"]);

    const human = await cli(["mcp", "add", "--dry-run", "--agent", "cursor"]);
    expect(human.stdout).toContain("Dry run: nothing was changed.");
    expect(fs.readdirSync(path.join(home, ".cursor"))).toEqual([]);
  });

  test("exits 1 when a tool failed, and still reports the others", async () => {
    if (process.platform === "win32") return;
    mkdir(".claude");
    mkdir(".cursor");
    fake("claude", FAKE_CLAUDE);

    const result = await cli(["--json", "mcp", "add"], { FAKE_CLAUDE_ADD_ERROR: "Config is locked" });

    expect(result.exitCode).toBe(1);
    expect(result.json<McpJson>().results).toEqual([
      expect.objectContaining({ agent: "claude-code", status: "failed", message: "Config is locked" }),
      expect.objectContaining({ agent: "cursor", status: "added" }),
    ]);
  });

  test("manual and unparsable configs don't fail the command", async () => {
    mkdir(".cursor");
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), '{ "mcpServers": {}, // mine\n}');

    const result = await cli(["--json", "mcp", "add"]);

    expect(result.exitCode).toBe(0);
    expect(result.json<McpJson>().results[0]).toMatchObject({ agent: "cursor", status: "manual" });
  });

  test("VS Code: code --add-mcp when code is on PATH", async () => {
    if (process.platform === "win32") return;
    mkdir(".copilot");
    fake("code", FAKE_LOGGER("code"));

    const result = await cli(["--json", "mcp", "add"]);

    expect(result.json<McpJson>().results).toEqual([
      expect.objectContaining({ agent: "github-copilot", status: "added", method: "cli" }),
    ]);
    expect(logLines()).toEqual([`code --add-mcp {"name":"opendocs","type":"http","url":"${URL}"}`]);
  });

  test("rejects unknown agents and --all with --agent", async () => {
    const unknown = await cli(["--json", "mcp", "add", "--agent", "notepad"]);
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stderr)).toMatchObject({ error: "unknown_agent" });

    const both = await cli(["--json", "mcp", "add", "--all", "--agent", "cursor"]);
    expect(both.exitCode).toBe(1);
    expect(JSON.parse(both.stderr)).toMatchObject({ error: "conflicting_options" });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("mcp remove takes it out again", async () => {
    mkdir(".cursor");
    await cli(["mcp", "add"]);

    const result = await cli(["--json", "mcp", "remove"]);

    expect(result.exitCode).toBe(0);
    expect(result.json<McpJson>().results).toEqual([
      expect.objectContaining({ agent: "cursor", status: "removed" }),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  });

  test("connect --json returns the links, copies the URL and opens nothing", async () => {
    if (process.platform === "win32") return;
    for (const name of ["pbcopy", "xclip", "wl-copy", "xsel"]) fake(name, FAKE_CLIPBOARD);
    for (const name of ["open", "xdg-open"]) fake(name, FAKE_LOGGER("open"));

    const result = await cli(["--json", "mcp", "connect", "claude"]);

    expect(result.exitCode).toBe(0);
    expect(result.json()).toEqual({
      app: "claude",
      openUrl:
        "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=OpenDocs.cc&connectorUrl=https%3A%2F%2Fmcp.opendocs.cc%2Fmcp",
      url: URL,
      copied: true,
    });
    expect(fs.readFileSync(clip, "utf8")).toBe(URL);
    expect(logLines()).toEqual([]);

    const chatgpt = await cli(["--json", "mcp", "connect", "ChatGPT"]);
    expect(chatgpt.json()).toMatchObject({ app: "chatgpt", openUrl: "https://chatgpt.com/plugins" });
  });

  test("connect without a clipboard tool reports copied: false; unknown apps are rejected", async () => {
    const result = await cli(["--json", "mcp", "connect", "chatgpt"]);
    expect(result.json()).toMatchObject({ copied: false });

    const bad = await cli(["--json", "mcp", "connect", "gemini"]);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: "unknown_app" });
  });

  test("connect opens the browser and prints the steps", async () => {
    if (process.platform === "win32") return;
    for (const name of ["open", "xdg-open"]) fake(name, FAKE_LOGGER("open"));

    const result = await cli(["mcp", "connect", "chatgpt"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Opening https://chatgpt.com/plugins");
    expect(result.stdout).toContain('Click "+" and choose "Add custom MCP server"');
    expect(result.stdout).toContain(URL);
    // The browser is started detached; give it a moment to log.
    for (let i = 0; i < 40 && logLines().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(logLines()).toEqual(["open https://chatgpt.com/plugins"]);
  });

  test("agent --install --mcp installs the skill and registers the server", async () => {
    mkdir(".cursor");

    const result = await cli(["--json", "agent", "--install", "--mcp"]);

    expect(result.exitCode).toBe(0);
    const json = result.json<{ installed: { agent: string }[]; mcp: McpJson }>();
    expect(json.installed.map((e) => e.agent)).toEqual(["cursor"]);
    expect(json.mcp.results).toEqual([expect.objectContaining({ agent: "cursor", status: "added" })]);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "opendocs", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(true);

    const human = await cli(["agent", "--install", "--mcp"]);
    expect(human.stdout).toContain("OpenDocs skill");
    expect(human.stdout).toMatch(/Cursor\s+already present\s+~\/\.cursor\/mcp\.json/);
  });

  test("agent --install without --mcp leaves MCP configs alone", async () => {
    mkdir(".cursor");

    const result = await cli(["--json", "agent", "--install"]);

    expect(result.json()).not.toHaveProperty("mcp");
    expect(fs.existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});
