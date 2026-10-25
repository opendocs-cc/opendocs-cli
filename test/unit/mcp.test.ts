import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_SUFFIX,
  MCP_URL,
  addMcpServer,
  chatAppUrl,
  copyToClipboard,
  findCodexEntry,
  findOnPath,
  mcpServerUrl,
  removeMcpServer,
  type ExecResult,
  type McpDeps,
} from "../../src/lib/mcp.js";

// Everything runs in-process against a temp home. `which` and `exec` are
// injected, so no real claude / codex / code binary is ever looked up or run.

type Call = { file: string; args: string[] };

let home: string;
let calls: Call[];
let bins: string[];
let execImpl: (call: Call) => ExecResult;
let env: Record<string, string>;
let platform: NodeJS.Platform;

function deps(): McpDeps {
  return {
    ctx: { home, env, platform },
    which: (name) => (bins.includes(name) ? `/fake/bin/${name}` : undefined),
    exec: async (file, args) => {
      const call = { file, args };
      calls.push(call);
      return execImpl(call);
    },
    pipe: async () => true,
  };
}

const p = (...parts: string[]) => path.join(home, ...parts);
const mkdir = (...parts: string[]) => fs.mkdirSync(p(...parts), { recursive: true });
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
  fs.writeFileSync(p(rel), content);
};
const read = (rel: string) => fs.readFileSync(p(rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));
const add = (agents?: string[], dryRun = false) => addMcpServer({ agents, dryRun }, deps());
const remove = (agents?: string[], dryRun = false) => removeMcpServer({ agents, dryRun }, deps());

/** Every file under home, relative, for "nothing was written" checks. */
function listFiles(dir = home): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(path.relative(home, full));
  }
  return out.sort();
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-mcp-")));
  calls = [];
  bins = [];
  env = {};
  platform = "linux";
  execImpl = () => ({ code: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("mcp add: JSON config files", () => {
  test("creates each tool's file with just our entry, in that tool's shape", async () => {
    mkdir(".cursor");
    mkdir(".codeium", "windsurf");
    mkdir(".gemini");
    mkdir(".config", "opencode");
    mkdir(".kiro");

    const run = await add();

    expect(run.url).toBe(MCP_URL);
    expect(run.results.map((r) => [r.agent, r.status, r.method])).toEqual([
      ["cursor", "added", "config"],
      ["gemini-cli", "added", "config"],
      ["opencode", "added", "config"],
      ["windsurf", "added", "config"],
      ["kiro-cli", "added", "config"],
    ]);
    expect(readJson(".cursor/mcp.json")).toEqual({ mcpServers: { opendocs: { url: MCP_URL } } });
    expect(readJson(".codeium/windsurf/mcp_config.json")).toEqual({
      mcpServers: { opendocs: { serverUrl: MCP_URL } },
    });
    expect(readJson(".gemini/settings.json")).toEqual({ mcpServers: { opendocs: { httpUrl: MCP_URL } } });
    expect(readJson(".config/opencode/opencode.json")).toEqual({
      mcp: { opendocs: { type: "remote", url: MCP_URL, enabled: true } },
    });
    expect(readJson(".kiro/settings/mcp.json")).toEqual({ mcpServers: { opendocs: { url: MCP_URL } } });
    expect(run.results.find((r) => r.agent === "cursor")).toEqual({
      agent: "cursor",
      name: "Cursor",
      status: "added",
      method: "config",
      path: p(".cursor", "mcp.json"),
    });
    // A file we created has nothing to back up.
    expect(fs.existsSync(p(".cursor", "mcp.json" + BACKUP_SUFFIX))).toBe(false);
  });

  test("Gemini with ~/.gemini/config (Antigravity) uses config/mcp_config.json and serverUrl", async () => {
    mkdir(".gemini", "config");

    const run = await add(["gemini"]);

    expect(run.results).toEqual([
      expect.objectContaining({ agent: "gemini-cli", status: "added", path: p(".gemini", "config", "mcp_config.json") }),
    ]);
    expect(readJson(".gemini/config/mcp_config.json")).toEqual({
      mcpServers: { opendocs: { serverUrl: MCP_URL } },
    });
    expect(fs.existsSync(p(".gemini", "settings.json"))).toBe(false);
  });

  test("Windsurf also writes Devin Desktop's file when ~/.config/devin exists", async () => {
    mkdir(".codeium", "windsurf");
    mkdir(".config", "devin");

    const run = await add();

    expect(run.results.map((r) => [r.agent, r.name, r.path])).toEqual([
      ["windsurf", "Windsurf", p(".codeium", "windsurf", "mcp_config.json")],
      ["windsurf", "Devin Desktop", p(".config", "devin", "mcp_config.json")],
    ]);
    expect(readJson(".config/devin/mcp_config.json")).toEqual({ mcpServers: { opendocs: { serverUrl: MCP_URL } } });
  });

  test("merges into an existing file, keeping other keys and servers in order", async () => {
    write(
      ".cursor/mcp.json",
      JSON.stringify({ theme: "dark", mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } }, z: [1, 2] }),
    );

    const run = await add(["cursor"]);

    expect(run.results[0].status).toBe("added");
    const text = read(".cursor/mcp.json");
    expect(text).toBe(
      JSON.stringify(
        {
          theme: "dark",
          mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, opendocs: { url: MCP_URL } },
          z: [1, 2],
        },
        null,
        2,
      ) + "\n",
    );
  });

  test("same URL is already_present and leaves the file untouched", async () => {
    const original = JSON.stringify({ mcpServers: { opendocs: { url: MCP_URL + "/", note: "mine" } } });
    write(".cursor/mcp.json", original);

    const run = await add(["cursor"]);

    expect(run.results[0]).toMatchObject({ status: "already_present", path: p(".cursor", "mcp.json") });
    expect(read(".cursor/mcp.json")).toBe(original);
    expect(fs.existsSync(p(".cursor", "mcp.json" + BACKUP_SUFFIX))).toBe(false);
  });

  test("a different URL is updated, and the first change keeps a one-time backup", async () => {
    const original = JSON.stringify({ mcpServers: { opendocs: { url: "https://old.example/mcp" } } }, null, 4);
    write(".kiro/settings/mcp.json", original);

    const first = await add(["kiro"]);

    expect(first.results[0].status).toBe("updated");
    expect(readJson(".kiro/settings/mcp.json")).toEqual({ mcpServers: { opendocs: { url: MCP_URL } } });
    expect(read(".kiro/settings/mcp.json" + BACKUP_SUFFIX)).toBe(original);

    // Change it again: the backup still holds the very first version.
    const second = await addMcpServer({ agents: ["kiro"], url: "https://staging.example/mcp" }, deps());
    expect(second.results[0].status).toBe("updated");
    expect(readJson(".kiro/settings/mcp.json")).toEqual({
      mcpServers: { opendocs: { url: "https://staging.example/mcp" } },
    });
    expect(read(".kiro/settings/mcp.json" + BACKUP_SUFFIX)).toBe(original);
  });

  test("keeps the file's permissions", async () => {
    if (process.platform === "win32") return;
    write(".cursor/mcp.json", "{}");
    fs.chmodSync(p(".cursor", "mcp.json"), 0o640);

    await add(["cursor"]);

    expect(fs.statSync(p(".cursor", "mcp.json")).mode & 0o777).toBe(0o640);
  });

  test("a file with comments or trailing commas is not written: manual with the line to add", async () => {
    const jsonc = `{
  // my servers
  "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" }, },
}
`;
    write(".cursor/mcp.json", jsonc);

    const run = await add(["cursor"]);

    expect(run.results[0]).toMatchObject({
      agent: "cursor",
      status: "manual",
      method: "config",
      path: p(".cursor", "mcp.json"),
      message: expect.stringContaining(`"mcpServers": {"opendocs":{"url":"${MCP_URL}"}}`),
    });
    expect(read(".cursor/mcp.json")).toBe(jsonc);
    expect(fs.existsSync(p(".cursor", "mcp.json" + BACKUP_SUFFIX))).toBe(false);
  });

  test("a file that isn't an object, or whose servers key isn't, is manual", async () => {
    write(".cursor/mcp.json", "[]");
    write(".kiro/settings/mcp.json", JSON.stringify({ mcpServers: ["x"] }));

    const run = await add(["cursor", "kiro"]);

    expect(run.results.map((r) => r.status)).toEqual(["manual", "manual"]);
    expect(read(".cursor/mcp.json")).toBe("[]");
  });

  test("an empty file counts as {}", async () => {
    write(".cursor/mcp.json", "\n");

    const run = await add(["cursor"]);

    expect(run.results[0].status).toBe("added");
    expect(readJson(".cursor/mcp.json")).toEqual({ mcpServers: { opendocs: { url: MCP_URL } } });
  });

  test("a symlinked config file is read but never written through", async () => {
    if (process.platform === "win32") return;
    mkdir("dotfiles");
    fs.writeFileSync(p("dotfiles", "cursor-mcp.json"), JSON.stringify({ mcpServers: {} }));
    mkdir(".cursor");
    fs.symlinkSync(p("dotfiles", "cursor-mcp.json"), p(".cursor", "mcp.json"));

    const run = await add(["cursor"]);

    expect(run.results[0]).toMatchObject({
      status: "manual",
      message: expect.stringContaining(`is a symlink to ${p("dotfiles", "cursor-mcp.json")}; left as is`),
    });
    expect(fs.lstatSync(p(".cursor", "mcp.json")).isSymbolicLink()).toBe(true);
    expect(readJson("dotfiles/cursor-mcp.json")).toEqual({ mcpServers: {} });

    // Already there (added by hand): reported as present, still not written.
    fs.writeFileSync(p("dotfiles", "cursor-mcp.json"), JSON.stringify({ mcpServers: { opendocs: { url: MCP_URL } } }));
    const again = await add(["cursor"]);
    expect(again.results[0].status).toBe("already_present");
    expect(fs.lstatSync(p(".cursor", "mcp.json")).isSymbolicLink()).toBe(true);
  });

  test("writes through a symlinked parent folder, like the skill install", async () => {
    if (process.platform === "win32") return;
    mkdir("dotfiles", "cursor");
    fs.symlinkSync(p("dotfiles", "cursor"), p(".cursor"), "dir");

    const run = await add();

    expect(run.results.map((r) => [r.agent, r.status])).toEqual([["cursor", "added"]]);
    expect(readJson("dotfiles/cursor/mcp.json")).toEqual({ mcpServers: { opendocs: { url: MCP_URL } } });
  });

  test("opencode: uses opencode.jsonc when that's the only config file", async () => {
    write(".config/opencode/opencode.jsonc", JSON.stringify({ $schema: "https://opencode.ai/config.json" }));

    const run = await add(["opencode"]);

    expect(run.results[0]).toMatchObject({ status: "added", path: p(".config", "opencode", "opencode.jsonc") });
    expect(readJson(".config/opencode/opencode.jsonc")).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { opendocs: { type: "remote", url: MCP_URL, enabled: true } },
    });
    expect(fs.existsSync(p(".config", "opencode", "opencode.json"))).toBe(false);
  });

  test("opencode and Kiro honour XDG_CONFIG_HOME and KIRO_HOME", async () => {
    env = { XDG_CONFIG_HOME: p("xdg"), KIRO_HOME: p("kiro-home") };

    const run = await add(["opencode", "kiro"]);

    expect(run.results.map((r) => r.path)).toEqual([
      p("xdg", "opencode", "opencode.json"),
      p("kiro-home", "settings", "mcp.json"),
    ]);
    expect(fs.existsSync(p("xdg", "opencode", "opencode.json"))).toBe(true);
  });
});

describe("mcp add: --dry-run", () => {
  test("reports what would happen and writes nothing", async () => {
    mkdir(".cursor");
    mkdir(".codex");
    mkdir(".kiro");
    write(".gemini/settings.json", JSON.stringify({ mcpServers: { opendocs: { httpUrl: "https://old.example" } } }));
    mkdir(".claude");
    bins = ["claude"];
    execImpl = ({ args }) =>
      args[1] === "get" ? { code: 1, stdout: "", stderr: "No MCP server named" } : { code: 0, stdout: "", stderr: "" };
    const before = listFiles();

    const run = await add(undefined, true);

    expect(run.dryRun).toBe(true);
    expect(run.results.map((r) => [r.agent, r.status])).toEqual([
      ["claude-code", "added"],
      ["codex", "added"],
      ["cursor", "added"],
      ["gemini-cli", "updated"],
      ["kiro-cli", "added"],
    ]);
    expect(listFiles()).toEqual(before);
    // Only the read-only lookup ran.
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([["mcp", "get"]]);
  });
});

describe("mcp add: Codex config.toml", () => {
  test("appends the table and keeps the rest of the file byte for byte", async () => {
    const original = `# my codex config
model = "gpt-5"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"`;
    write(".codex/config.toml", original);

    const run = await add(["codex"]);

    expect(run.results[0]).toEqual({
      agent: "codex",
      name: "Codex",
      status: "added",
      method: "config",
      path: p(".codex", "config.toml"),
      message: "Sign in with: codex mcp login opendocs",
    });
    expect(read(".codex/config.toml")).toBe(`${original}\n\n[mcp_servers.opendocs]\nurl = "${MCP_URL}"\n`);
    expect(read(".codex/config.toml" + BACKUP_SUFFIX)).toBe(original);
    // Never runs `codex mcp add` (it would start a browser sign-in).
    expect(calls).toEqual([]);
  });

  test("creates config.toml in $CODEX_HOME, and keeps CRLF line endings", async () => {
    env = { CODEX_HOME: p("codex-home") };
    await add(["codex"]);
    expect(read("codex-home/config.toml")).toBe(`[mcp_servers.opendocs]\nurl = "${MCP_URL}"\n`);

    write(".codex/config.toml", 'model = "o3"\r\n');
    env = {};
    await add(["codex"]);
    expect(read(".codex/config.toml")).toBe(`model = "o3"\r\n\r\n[mcp_servers.opendocs]\r\nurl = "${MCP_URL}"\r\n`);
  });

  test("already there: already_present, nothing written", async () => {
    const original = `[mcp_servers."opendocs"]\nurl = '${MCP_URL}' # added by hand\n`;
    write(".codex/config.toml", original);

    const run = await add(["codex"]);

    expect(run.results[0].status).toBe("already_present");
    expect(read(".codex/config.toml")).toBe(original);
  });

  test("another URL, an inline table or mcp_servers = {...}: manual, nothing written", async () => {
    for (const original of [
      `[mcp_servers.opendocs]\nurl = "https://old.example/mcp"\n`,
      `[mcp_servers]\nopendocs = { url = "https://old.example/mcp" }\n`,
      `mcp_servers = { linear = { url = "https://mcp.linear.app/mcp" } }\n`,
    ]) {
      write(".codex/config.toml", original);
      const run = await add(["codex"]);
      expect(run.results[0].status).toBe("manual");
      expect(read(".codex/config.toml")).toBe(original);
    }
  });

  test("findCodexEntry ignores look-alikes inside multi-line strings", () => {
    expect(findCodexEntry(`instructions = """\n[mcp_servers.opendocs]\nurl = "x"\n"""\n`)).toMatchObject({
      present: false,
    });
    expect(findCodexEntry(`[mcp_servers.opendocs.env]\nA = "1"\n`)).toMatchObject({ present: true });
    expect(findCodexEntry(`[mcp_servers.opendocs]\nurl = "${MCP_URL}"\n`)).toMatchObject({
      present: true,
      url: MCP_URL,
      tableLine: 0,
    });
  });
});

describe("mcp add: tools with their own CLI", () => {
  test("Claude Code: runs claude mcp add with user scope when it isn't registered", async () => {
    mkdir(".claude");
    bins = ["claude"];
    execImpl = ({ args }) =>
      args[1] === "get"
        ? { code: 1, stdout: "", stderr: 'No MCP server named "opendocs".' }
        : { code: 0, stdout: "Added HTTP MCP server opendocs", stderr: "" };

    const run = await add();

    expect(calls).toEqual([
      { file: "/fake/bin/claude", args: ["mcp", "get", "opendocs"] },
      {
        file: "/fake/bin/claude",
        args: ["mcp", "add", "--transport", "http", "--scope", "user", "opendocs", MCP_URL],
      },
    ]);
    expect(run.results).toEqual([
      {
        agent: "claude-code",
        name: "Claude Code",
        status: "added",
        method: "cli",
        command: `claude mcp add --transport http --scope user opendocs ${MCP_URL}`,
      },
    ]);
    // ~/.claude.json is never touched.
    expect(fs.existsSync(p(".claude.json"))).toBe(false);
  });

  test("Claude Code: already registered with this URL", async () => {
    mkdir(".claude");
    bins = ["claude"];
    execImpl = () => ({
      code: 0,
      stdout: `opendocs:\n  Scope: User config\n  Type: http\n  URL: ${MCP_URL}\n`,
      stderr: "",
    });

    const run = await add();

    expect(run.results[0].status).toBe("already_present");
    expect(calls).toHaveLength(1);
  });

  test("Claude Code: registered with another URL is left for the user", async () => {
    mkdir(".claude");
    bins = ["claude"];
    execImpl = () => ({ code: 0, stdout: "opendocs:\n  URL: https://old.example/mcp\n", stderr: "" });

    const run = await add();

    expect(run.results[0]).toMatchObject({
      status: "manual",
      command: expect.stringContaining("claude mcp remove opendocs && claude mcp add"),
    });
    expect(calls).toHaveLength(1);
  });

  test("Claude Code: without the claude command, prints the command (manual)", async () => {
    mkdir(".claude");

    const run = await add();

    expect(run.results[0]).toMatchObject({
      status: "manual",
      method: "cli",
      command: `claude mcp add --transport http --scope user opendocs ${MCP_URL}`,
    });
    expect(calls).toEqual([]);
  });

  test("Claude Code: a failing add is failed, with its error", async () => {
    mkdir(".claude");
    bins = ["claude"];
    execImpl = ({ args }) =>
      args[1] === "get" ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "\nboom: no config\n" };

    const run = await add();

    expect(run.results[0]).toMatchObject({ status: "failed", message: "boom: no config" });
  });

  test("VS Code: uses code --add-mcp when code is on PATH", async () => {
    mkdir(".copilot");
    bins = ["code"];

    const run = await add();

    expect(calls).toEqual([
      {
        file: "/fake/bin/code",
        args: ["--add-mcp", JSON.stringify({ name: "opendocs", type: "http", url: MCP_URL })],
      },
    ]);
    expect(run.results[0]).toMatchObject({ agent: "github-copilot", status: "added", method: "cli" });
  });

  test("VS Code: without code, merges servers.opendocs into the user mcp.json if the folder exists", async () => {
    mkdir(".config", "Code", "User");
    write(".config/Code/User/mcp.json", JSON.stringify({ servers: {}, inputs: [] }));

    const run = await add();

    expect(run.results).toEqual([
      expect.objectContaining({ agent: "github-copilot", status: "added", method: "config" }),
    ]);
    expect(readJson(".config/Code/User/mcp.json")).toEqual({
      servers: { opendocs: { type: "http", url: MCP_URL } },
      inputs: [],
    });
  });

  test("VS Code: macOS and Windows user folders", async () => {
    platform = "darwin";
    mkdir("Library", "Application Support", "Code", "User");
    let run = await add(["vscode"]);
    expect(run.results[0].path).toBe(p("Library", "Application Support", "Code", "User", "mcp.json"));

    platform = "win32";
    env = { APPDATA: "C:\\Users\\u\\AppData\\Roaming" };
    run = await add(["vscode"], true);
    expect(run.results[0]).toMatchObject({ status: "skipped", path: "C:\\Users\\u\\AppData\\Roaming\\Code\\User\\mcp.json" });
  });

  test("VS Code: neither code nor the folder is skipped", async () => {
    const run = await add(["copilot"]);

    expect(run.results[0]).toMatchObject({ agent: "github-copilot", status: "skipped" });
    expect(listFiles()).toEqual([]);
  });
});

describe("mcp add: picking tools", () => {
  test("tools without a config we write get a one-line instruction", async () => {
    mkdir(".cline");
    mkdir(".config", "zed");
    mkdir(".config", "goose");

    const run = await add();

    expect(run.results.map((r) => [r.agent, r.status])).toEqual([
      ["cline", "manual"],
      ["goose", "manual"],
      ["zed", "manual"],
    ]);
    for (const r of run.results) expect(r.message).toContain(MCP_URL);
    expect(run.results.find((r) => r.agent === "zed")).toMatchObject({
      path: p(".config", "zed", "settings.json"),
      message: expect.stringContaining('"context_servers"'),
    });
    expect(run.results.find((r) => r.agent === "goose")).toMatchObject({ method: "cli", command: "goose configure" });
    expect(listFiles()).toEqual([]);
  });

  test("no --agent: only detected tools; the rest are listed as notDetected", async () => {
    mkdir(".cursor");

    const run = await add();

    expect(run.results.map((r) => r.agent)).toEqual(["cursor"]);
    expect(run.notDetected).toContain("claude-code");
    expect(run.notDetected).toContain("zed");
    expect(run.notDetected).not.toContain("cursor");
  });

  test("--agent forces tools that weren't found, with aliases and commas", async () => {
    const run = await add(["kiro,windsurf", "devin"]);

    expect(run.notDetected).toEqual([]);
    expect(run.results.map((r) => [r.agent, r.status, r.path])).toEqual([
      ["windsurf", "added", p(".codeium", "windsurf", "mcp_config.json")],
      ["kiro-cli", "added", p(".kiro", "settings", "mcp.json")],
    ]);
  });

  test("unknown ids are rejected before anything is written", async () => {
    await expect(add(["cursor", "notepad"])).rejects.toMatchObject({
      code: "unknown_agent",
      message: expect.stringContaining("zed"),
    });
    expect(listFiles()).toEqual([]);
  });

  test("OPENDOCS_MCP_URL overrides the server URL", () => {
    expect(mcpServerUrl({})).toBe(MCP_URL);
    expect(mcpServerUrl({ OPENDOCS_MCP_URL: " http://localhost:8787/mcp " })).toBe("http://localhost:8787/mcp");
  });
});

describe("mcp remove", () => {
  test("removes our entry from JSON files and keeps everything else", async () => {
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: { linear: { url: "x" }, opendocs: { url: MCP_URL } } }));
    write(".kiro/settings/mcp.json", JSON.stringify({ mcpServers: { other: { url: "y" } } }));

    const dry = await remove(["cursor", "kiro"], true);
    expect(dry.results.map((r) => r.status)).toEqual(["removed", "not_present"]);
    expect(readJson(".cursor/mcp.json").mcpServers.opendocs).toBeDefined();

    const run = await remove(["cursor", "kiro"]);

    expect(run.results.map((r) => r.status)).toEqual(["removed", "not_present"]);
    expect(readJson(".cursor/mcp.json")).toEqual({ mcpServers: { linear: { url: "x" } } });
    expect(fs.existsSync(p(".cursor", "mcp.json" + BACKUP_SUFFIX))).toBe(true);
    expect(fs.existsSync(p(".kiro", "settings", "mcp.json" + BACKUP_SUFFIX))).toBe(false);
  });

  test("Codex: add then remove gives back the original file", async () => {
    const original = `model = "o3"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n`;
    write(".codex/config.toml", original);

    await add(["codex"]);
    const run = await remove(["codex"]);

    expect(run.results[0]).toMatchObject({ status: "removed", method: "config" });
    expect(read(".codex/config.toml")).toBe(original);
  });

  test("Codex: removing a table in the middle keeps the comment above the next table", async () => {
    write(
      ".codex/config.toml",
      `[mcp_servers.opendocs]\nurl = "${MCP_URL}"\n\n[mcp_servers.opendocs.env]\nA = "1"\n\n# linear\n[mcp_servers.linear]\nurl = "x"\n`,
    );

    await remove(["codex"]);

    expect(read(".codex/config.toml")).toBe(`\n# linear\n[mcp_servers.linear]\nurl = "x"\n`);
  });

  test("Codex: uses codex mcp remove when codex is on PATH", async () => {
    write(".codex/config.toml", `[mcp_servers.opendocs]\nurl = "${MCP_URL}"\n`);
    bins = ["codex"];

    const run = await remove(["codex"]);

    expect(calls).toEqual([{ file: "/fake/bin/codex", args: ["mcp", "remove", "opendocs"] }]);
    expect(run.results[0]).toMatchObject({ status: "removed", method: "cli", command: "codex mcp remove opendocs" });
  });

  test("Claude Code: claude mcp remove -s user; missing is not_present", async () => {
    mkdir(".claude");
    bins = ["claude"];
    execImpl = () => ({ code: 1, stdout: "", stderr: 'No user-scoped MCP server found with name: opendocs' });

    const run = await remove();

    expect(calls[0].args).toEqual(["mcp", "remove", "opendocs", "-s", "user"]);
    expect(run.results[0]).toMatchObject({ agent: "claude-code", status: "not_present" });
  });
});

describe("chat apps and helpers", () => {
  test("Claude's link opens the prefilled custom connector dialog", () => {
    expect(chatAppUrl("claude", MCP_URL)).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=OpenDocs.cc&connectorUrl=https%3A%2F%2Fmcp.opendocs.cc%2Fmcp",
    );
    expect(chatAppUrl("chatgpt", MCP_URL)).toBe("https://chatgpt.com/plugins");
  });

  test("copyToClipboard picks the platform's tool and reports failure", async () => {
    const piped: string[] = [];
    const base = deps();
    const withPipe = (ok: boolean): McpDeps => ({
      ...base,
      pipe: async (file, args, input) => {
        piped.push(`${file} ${args.join(" ")} <${input}`);
        return ok;
      },
    });

    platform = "darwin";
    bins = ["pbcopy"];
    expect(await copyToClipboard("hello", { ...withPipe(true), ctx: { home, env, platform } })).toBe(true);
    expect(piped).toEqual(["/fake/bin/pbcopy  <hello"]);

    platform = "linux";
    bins = ["xclip"];
    expect(await copyToClipboard("hi", { ...withPipe(false), ctx: { home, env, platform } })).toBe(false);
    expect(piped[1]).toBe("/fake/bin/xclip -selection clipboard <hi");

    bins = [];
    expect(await copyToClipboard("hi", { ...withPipe(true), ctx: { home, env, platform } })).toBe(false);
  });

  test("findOnPath only returns executables from absolute PATH entries", () => {
    if (process.platform === "win32") return;
    mkdir("bin");
    mkdir("other");
    fs.writeFileSync(p("bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(p("other", "codex"), "not executable", { mode: 0o644 });
    const ctx = { home, platform: "linux" as const, env: { PATH: ["relative", p("other"), p("bin")].join(":") } };

    expect(findOnPath("claude", ctx)).toBe(p("bin", "claude"));
    expect(findOnPath("codex", ctx)).toBeUndefined();
    expect(findOnPath("code", ctx)).toBeUndefined();
  });
});
