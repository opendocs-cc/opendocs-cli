// Registers the remote OpenDocs MCP server in the AI coding tools on this
// machine (`opendocs mcp add`), takes it out again (`opendocs mcp remove`)
// and builds the links that add it to the Claude and ChatGPT apps
// (`opendocs mcp connect`).
//
// The server signs people in with OAuth from each tool, so no API key is
// ever written anywhere. Tools come from AGENT_SPECS (agent-skills.ts) plus
// Zed. Per tool:
//   - Claude Code: `claude mcp add` (its ~/.claude.json is large and written
//     constantly, so it's never edited here; without the CLI the command is
//     printed instead).
//   - VS Code / GitHub Copilot: `code --add-mcp` when `code` is on PATH,
//     else the user mcp.json.
//   - Codex: appends a [mcp_servers.opendocs] table to config.toml. Not
//     `codex mcp add`: for an OAuth server it starts a browser sign-in and
//     waits for it, which can't finish inside this command.
//   - Cursor, Windsurf / Devin Desktop, Gemini CLI / Antigravity, opencode,
//     Kiro: their JSON config file.
//   - Everything else: a one-line instruction (status `manual`).
//
// JSON files are only written when they parse as plain JSON (a file with
// comments or trailing commas gets `manual` instead), keep a one-time
// `<file>.opendocs-backup`, and are replaced atomically. A config file that
// is a symlink is left alone and reported, like a symlinked skill folder.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_IDS,
  currentAgentEnv,
  isAgentDetected,
  lstatOrNull,
  normalizeAgentId,
  resolveAgents,
  writeFileAtomic,
  type AgentEnv,
} from "./agent-skills.js";

export const MCP_URL = "https://mcp.opendocs.cc/mcp";
/** The key the server is registered under in every tool. */
export const MCP_SERVER_NAME = "opendocs";
/** The name people see in chat apps. */
export const MCP_DISPLAY_NAME = "OpenDocs.cc";
export const MCP_GUIDE_URL = "https://opendocs.cc/mcp";
export const BACKUP_SUFFIX = ".opendocs-backup";

/** The server URL. `OPENDOCS_MCP_URL` overrides it (local or staging servers). */
export function mcpServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENDOCS_MCP_URL?.trim() || MCP_URL;
}

// ── Running other programs ──────────────────────────────────────────────

export interface ExecResult {
  /** Exit code; null when the program couldn't start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it didn't run to completion (timed out, couldn't start). */
  error?: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface McpDeps {
  ctx: AgentEnv;
  /** Runs a program (no shell) and collects its output. Never rejects. */
  exec: ExecFn;
  /** Writes `input` to a program's stdin; true when it exits 0. Never rejects. */
  pipe(file: string, args: string[], input: string): Promise<boolean>;
  /** Absolute path of a program on PATH, or undefined. */
  which(name: string): string | undefined;
}

export function defaultMcpDeps(ctx: AgentEnv = currentAgentEnv()): McpDeps {
  return {
    ctx,
    exec: execProgram,
    pipe: pipeToProgram,
    which: (name) => findOnPath(name, ctx),
  };
}

const CLI_TIMEOUT_MS = 30_000;

export function execProgram(
  file: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: e.killed
            ? `timed out after ${Math.round(timeoutMs / 1000)}s`
            : typeof e.code === "number"
              ? undefined
              : e.message,
        });
      },
    );
    // Nothing to say on stdin: a prompt gets EOF instead of waiting.
    child.stdin?.end();
  });
}

function pipeToProgram(file: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // stdout/stderr ignored: xclip and wl-copy fork to keep serving the
    // clipboard, and a captured pipe would keep us waiting on them.
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, 5_000);
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
    child.stdin?.on("error", () => done(false));
    child.stdin?.end(input);
  });
}

/**
 * The program's absolute path when it's on PATH. Only absolute PATH entries
 * count (never the current folder). On Windows only `.exe` files count:
 * npm's `.cmd` shims can't run without a shell, and we don't use one.
 */
export function findOnPath(name: string, ctx: AgentEnv): string | undefined {
  const windows = ctx.platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const raw = ctx.env.PATH ?? ctx.env.Path ?? "";
  const file = windows ? `${name}.exe` : name;
  for (const dir of raw.split(windows ? ";" : ":")) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, file);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

// ── Tools and where their config lives ──────────────────────────────────

export type McpAddStatus = "added" | "updated" | "already_present" | "manual" | "skipped" | "failed";
export type McpRemoveStatus = "removed" | "not_present" | "manual" | "skipped" | "failed";

export interface McpResult<S extends string = McpAddStatus | McpRemoveStatus> {
  agent: string;
  name: string;
  status: S;
  method: "cli" | "config";
  path?: string;
  command?: string;
  message?: string;
}

export interface McpRun<S extends string> {
  url: string;
  results: McpResult<S>[];
  /** Supported tools that weren't found (only when no `--agent` was given). */
  notDetected: string[];
  dryRun?: true;
}

type Outcome<S extends string> = Omit<McpResult<S>, "agent" | "name">;

interface JsonTarget {
  kind: "json";
  name: string;
  path: string;
  /** Top-level key that holds the servers: `mcpServers`, `servers` (VS Code) or `mcp` (opencode). */
  container: string;
  entry: Record<string, unknown>;
  /** The entry's URL field: `url`, `serverUrl` (Windsurf, Antigravity) or `httpUrl` (Gemini CLI). */
  urlKey: string;
}

type Target =
  | JsonTarget
  | { kind: "claude"; name: string }
  | { kind: "codex"; name: string; path: string }
  | { kind: "vscode"; name: string; userDir: string; file: JsonTarget }
  | { kind: "manual"; name: string; message: string; removeMessage: string; command?: string; path?: string }
  | { kind: "skip"; name: string; message: string };

interface Paths {
  p: path.PlatformPath;
  home(...parts: string[]): string;
  env(name: string): string | undefined;
  xdgConfig(...parts: string[]): string;
  windows: boolean;
  platform: NodeJS.Platform;
}

function makePaths(ctx: AgentEnv): Paths {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const env = (name: string) => {
    const value = ctx.env[name]?.trim();
    return value ? value : undefined;
  };
  const xdg = env("XDG_CONFIG_HOME") ?? p.join(ctx.home, ".config");
  return {
    p,
    home: (...parts) => p.join(ctx.home, ...parts),
    env,
    xdgConfig: (...parts) => p.join(xdg, ...parts),
    windows: ctx.platform === "win32",
    platform: ctx.platform,
  };
}

function appData(r: Paths): string {
  return r.env("APPDATA") ?? r.home("AppData", "Roaming");
}

/** VS Code's `User` folder; its mcp.json holds user-level servers. */
function vscodeUserDir(r: Paths): string {
  if (r.platform === "darwin") return r.home("Library", "Application Support", "Code", "User");
  if (r.windows) return r.p.join(appData(r), "Code", "User");
  return r.xdgConfig("Code", "User");
}

const windsurfDir = (r: Paths) => r.home(".codeium", "windsurf");
const devinDir = (r: Paths) => r.home(".config", "devin");
const zedDir = (r: Paths) => (r.windows ? r.p.join(appData(r), "Zed") : r.xdgConfig("zed"));

/** Tools only `mcp` knows about (no skills folder). */
const MCP_ONLY_AGENTS = [{ id: "zed", name: "Zed" }];

export const MCP_AGENT_IDS: string[] = [...AGENT_IDS, ...MCP_ONLY_AGENTS.map((a) => a.id)];

interface McpAgent {
  id: string;
  name: string;
  detected: boolean;
}

function mcpAgents(ctx: AgentEnv): McpAgent[] {
  const r = makePaths(ctx);
  // Some tools are found by their MCP config folder too: VS Code without the
  // Copilot CLI, Devin Desktop without Windsurf.
  const extra: Record<string, string[]> = {
    "github-copilot": [vscodeUserDir(r)],
    windsurf: [devinDir(r)],
    zed: [zedDir(r)],
  };
  const found = (id: string) => (extra[id] ?? []).some((dir) => fs.existsSync(dir));
  return [
    ...resolveAgents(ctx).map((a) => ({ id: a.id, name: a.name, detected: isAgentDetected(a) || found(a.id) })),
    ...MCP_ONLY_AGENTS.map((a) => ({ ...a, detected: found(a.id) })),
  ];
}

/** Display names by tool id. */
export function mcpAgentNames(ctx: AgentEnv = currentAgentEnv()): Map<string, string> {
  return new Map([
    ...resolveAgents(ctx).map((a): [string, string] => [a.id, a.name]),
    ...MCP_ONLY_AGENTS.map((a): [string, string] => [a.id, a.name]),
  ]);
}

function normalizeMcpAgentId(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  return normalizeAgentId(value) ?? MCP_ONLY_AGENTS.find((a) => a.id === value)?.id;
}

/** The tools to act on: the named ones (even if not found), else every detected one. */
export function selectMcpAgents(
  ids: string[] | undefined,
  ctx: AgentEnv,
): { selected: { agent: McpAgent; forced: boolean }[]; notDetected: string[] } {
  const all = mcpAgents(ctx);
  if (ids) {
    const wanted = new Set<string>();
    for (const raw of ids.flatMap((v) => v.split(",")).filter((v) => v.trim())) {
      const id = normalizeMcpAgentId(raw);
      if (!id) {
        throw {
          code: "unknown_agent",
          message: `Unknown agent "${raw.trim()}". Supported: ${MCP_AGENT_IDS.join(", ")}.`,
        };
      }
      wanted.add(id);
    }
    return {
      selected: all.filter((a) => wanted.has(a.id)).map((agent) => ({ agent, forced: true })),
      notDetected: [],
    };
  }
  return {
    selected: all.filter((a) => a.detected).map((agent) => ({ agent, forced: false })),
    notDetected: all.filter((a) => !a.detected).map((a) => a.id),
  };
}

function json(
  name: string,
  file: string,
  container: string,
  urlKey: string,
  entry: Record<string, unknown>,
): JsonTarget {
  return { kind: "json", name, path: file, container, urlKey, entry };
}

function manual(name: string, message: string, extra: { command?: string; path?: string } = {}): Target {
  return {
    kind: "manual",
    name,
    message,
    removeMessage: `If you added it, remove the "${MCP_SERVER_NAME}" MCP server in ${name}'s settings.`,
    ...extra,
  };
}

function targetsFor(id: string, name: string, r: Paths, url: string, forced: boolean): Target[] {
  const exists = (target: string) => fs.existsSync(target);
  switch (id) {
    case "claude-code":
      return [{ kind: "claude", name }];
    case "codex": {
      // developers.openai.com/codex/mcp: [mcp_servers.<name>] url = "..." in config.toml
      const dir = r.env("CODEX_HOME") ?? r.home(".codex");
      return [{ kind: "codex", name, path: r.p.join(dir, "config.toml") }];
    }
    case "cursor":
      // cursor.com/docs/context/mcp: ~/.cursor/mcp.json
      return [json(name, r.home(".cursor", "mcp.json"), "mcpServers", "url", { url })];
    case "github-copilot": {
      // code.visualstudio.com/docs/copilot/customization/mcp-servers: user mcp.json, "servers"
      const userDir = vscodeUserDir(r);
      return [
        {
          kind: "vscode",
          name: "GitHub Copilot (VS Code)",
          userDir,
          file: json("GitHub Copilot (VS Code)", r.p.join(userDir, "mcp.json"), "servers", "url", {
            type: "http",
            url,
          }),
        },
      ];
    }
    case "gemini-cli": {
      // Antigravity: ~/.gemini/config/mcp_config.json (serverUrl);
      // Gemini CLI: ~/.gemini/settings.json (httpUrl for streamable HTTP).
      const custom = r.env("GEMINI_CLI_HOME");
      const dir = custom ? r.p.join(custom, ".gemini") : r.home(".gemini");
      if (exists(r.p.join(dir, "config"))) {
        return [
          json("Gemini / Antigravity", r.p.join(dir, "config", "mcp_config.json"), "mcpServers", "serverUrl", {
            serverUrl: url,
          }),
        ];
      }
      return [json(name, r.p.join(dir, "settings.json"), "mcpServers", "httpUrl", { httpUrl: url })];
    }
    case "opencode": {
      // opencode.ai/docs/mcp-servers: "mcp": { name: { type: "remote", url, enabled } }
      const dir = r.xdgConfig("opencode");
      const jsonc = r.p.join(dir, "opencode.jsonc");
      const plain = r.p.join(dir, "opencode.json");
      const file = !exists(plain) && exists(jsonc) ? jsonc : plain;
      return [json(name, file, "mcp", "url", { type: "remote", url, enabled: true })];
    }
    case "windsurf": {
      // docs.windsurf.com/windsurf/cascade/mcp: ~/.codeium/windsurf/mcp_config.json (serverUrl);
      // Devin Desktop (Windsurf's successor) keeps the same file in ~/.config/devin.
      const targets: Target[] = [];
      const devin = exists(devinDir(r));
      if (exists(windsurfDir(r)) || (forced && !devin)) {
        targets.push(
          json(name, r.p.join(windsurfDir(r), "mcp_config.json"), "mcpServers", "serverUrl", { serverUrl: url }),
        );
      }
      if (devin) {
        targets.push(
          json("Devin Desktop", r.p.join(devinDir(r), "mcp_config.json"), "mcpServers", "serverUrl", {
            serverUrl: url,
          }),
        );
      }
      return targets;
    }
    case "kiro-cli": {
      // kiro.dev/docs/mcp/configuration: ~/.kiro/settings/mcp.json
      const custom = r.env("KIRO_HOME");
      const dir = custom && r.p.isAbsolute(custom) ? custom : r.home(".kiro");
      return [json(name, r.p.join(dir, "settings", "mcp.json"), "mcpServers", "url", { url })];
    }
    case "zed":
      return [
        manual(name, `Add "context_servers": {"${MCP_SERVER_NAME}": {"url": "${url}"}} to Zed's settings.json.`, {
          path: r.p.join(zedDir(r), "settings.json"),
        }),
      ];
    case "cline":
      return [manual(name, `In Cline's MCP Servers panel, add a remote server "${MCP_SERVER_NAME}" with URL ${url}.`)];
    case "amp":
      return [
        manual(name, `Add "${MCP_SERVER_NAME}": {"url": "${url}"} under "amp.mcpServers" in Amp's settings.json.`),
      ];
    case "goose":
      return [
        manual(
          name,
          `Run goose configure, then Add Extension > Remote Extension (Streamable HTTP): name "${MCP_SERVER_NAME}", URL ${url}.`,
          { command: "goose configure" },
        ),
      ];
    default:
      return [
        manual(
          name,
          `Add a remote MCP server "${MCP_SERVER_NAME}" with URL ${url} in ${name}'s MCP settings (stdio only: npx -y mcp-remote ${url}).`,
        ),
      ];
  }
}

// ── add / remove ────────────────────────────────────────────────────────

export interface McpRunOptions {
  /** Tool ids or aliases; omitted = every detected tool. */
  agents?: string[];
  dryRun?: boolean;
  /** Defaults to mcpServerUrl(). */
  url?: string;
}

export async function addMcpServer(
  options: McpRunOptions = {},
  deps: McpDeps = defaultMcpDeps(),
): Promise<McpRun<McpAddStatus>> {
  return runForTargets(options, deps, addTarget);
}

export async function removeMcpServer(
  options: McpRunOptions = {},
  deps: McpDeps = defaultMcpDeps(),
): Promise<McpRun<McpRemoveStatus>> {
  return runForTargets(options, deps, removeTarget);
}

async function runForTargets<S extends string>(
  options: McpRunOptions,
  deps: McpDeps,
  act: (target: Target, url: string, dryRun: boolean, deps: McpDeps) => Promise<Outcome<S>>,
): Promise<McpRun<S>> {
  const url = options.url ?? mcpServerUrl(deps.ctx.env);
  const dryRun = !!options.dryRun;
  const { selected, notDetected } = selectMcpAgents(options.agents, deps.ctx);
  const r = makePaths(deps.ctx);
  const results: McpResult<S>[] = [];
  for (const { agent, forced } of selected) {
    for (const target of targetsFor(agent.id, agent.name, r, url, forced)) {
      let outcome: Outcome<S>;
      try {
        outcome = await act(target, url, dryRun, deps);
      } catch (err) {
        outcome = { status: "failed" as S, method: "config", message: (err as Error).message };
      }
      results.push({
        agent: agent.id,
        name: target.name,
        status: outcome.status,
        method: outcome.method,
        ...(outcome.path ? { path: outcome.path } : {}),
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(outcome.message ? { message: outcome.message } : {}),
      });
    }
  }
  return { url, results, notDetected, ...(dryRun ? { dryRun: true as const } : {}) };
}

async function addTarget(
  target: Target,
  url: string,
  dryRun: boolean,
  deps: McpDeps,
): Promise<Outcome<McpAddStatus>> {
  switch (target.kind) {
    case "json":
      return addToJson(target, url, dryRun);
    case "codex":
      return addToCodex(target.path, url, dryRun);
    case "claude":
      return addToClaude(url, dryRun, deps);
    case "vscode":
      return addToVsCode(target, url, dryRun, deps);
    case "manual":
      return {
        status: "manual",
        method: target.command ? "cli" : "config",
        ...(target.path ? { path: target.path } : {}),
        ...(target.command ? { command: target.command } : {}),
        message: target.message,
      };
    case "skip":
      return { status: "skipped", method: "config", message: target.message };
  }
}

async function removeTarget(
  target: Target,
  _url: string,
  dryRun: boolean,
  deps: McpDeps,
): Promise<Outcome<McpRemoveStatus>> {
  switch (target.kind) {
    case "json":
      return removeFromJson(target, dryRun);
    case "codex":
      return removeFromCodex(target.path, dryRun, deps);
    case "claude":
      return removeFromClaude(dryRun, deps);
    case "vscode":
      // VS Code has no CLI to remove a server; its mcp.json is plain JSON.
      return removeFromJson(target.file, dryRun);
    case "manual":
      return {
        status: "manual",
        method: "config",
        ...(target.path ? { path: target.path } : {}),
        message: target.removeMessage,
      };
    case "skip":
      return { status: "skipped", method: "config", message: target.message };
  }
}

// ── JSON config files ───────────────────────────────────────────────────

type JsonRead =
  | {
      ok: true;
      data: Record<string, unknown>;
      exists: boolean;
      mode: number;
      /** Set when the file is a symlink: read through it, never written. */
      symlink?: string;
    }
  | { ok: false; status: "manual" | "failed"; message: string };

function readJsonConfig(file: string, container: string): JsonRead {
  const st = lstatOrNull(file);
  const symlink = st?.isSymbolicLink() ? linkTarget(file) : undefined;
  const real = symlink ? statOrNull(file) : st;
  if (symlink && !real?.isFile()) {
    return { ok: false, status: "manual", message: `${file} is a symlink to ${symlink}; left as is` };
  }
  if (real && !real.isFile()) {
    return { ok: false, status: "failed", message: `${file} exists and is not a file` };
  }
  if (!real) return { ok: true, data: {}, exists: false, mode: 0o600 };

  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: "manual",
        message: `${file} isn't plain JSON (comments or trailing commas?); left as is`,
      };
    }
  }
  if (!isPlainObject(data) || (data[container] !== undefined && !isPlainObject(data[container]))) {
    return { ok: false, status: "manual", message: `${file} doesn't look like an MCP config; left as is` };
  }
  return { ok: true, data, exists: true, mode: real.mode & 0o777, ...(symlink ? { symlink } : {}) };
}

function addToJson(target: JsonTarget, url: string, dryRun: boolean): Outcome<McpAddStatus> {
  const base = { method: "config" as const, path: target.path };
  const snippet = `"${target.container}": ${JSON.stringify({ [MCP_SERVER_NAME]: target.entry })}`;
  const read = readJsonConfig(target.path, target.container);
  if (!read.ok) {
    return {
      ...base,
      status: read.status,
      message: read.status === "manual" ? `${read.message}. Add ${snippet} yourself.` : read.message,
    };
  }
  const servers = (read.data[target.container] ?? {}) as Record<string, unknown>;
  const current = Object.hasOwn(servers, MCP_SERVER_NAME) ? servers[MCP_SERVER_NAME] : undefined;
  if (isPlainObject(current) && sameUrl(current[target.urlKey], url)) {
    return { ...base, status: "already_present" };
  }
  if (read.symlink) {
    return {
      ...base,
      status: "manual",
      message: `${target.path} is a symlink to ${read.symlink}; left as is. Add ${snippet} yourself.`,
    };
  }
  const status = current === undefined ? "added" : "updated";
  if (dryRun) return { ...base, status };

  servers[MCP_SERVER_NAME] = target.entry;
  read.data[target.container] = servers;
  try {
    writeConfig(target.path, JSON.stringify(read.data, null, 2) + "\n", read.exists, read.mode);
  } catch (err) {
    return { ...base, status: "failed", message: (err as Error).message };
  }
  return { ...base, status };
}

function removeFromJson(target: JsonTarget, dryRun: boolean): Outcome<McpRemoveStatus> {
  const base = { method: "config" as const, path: target.path };
  if (!lstatOrNull(target.path)) return { ...base, status: "not_present" };
  const read = readJsonConfig(target.path, target.container);
  if (!read.ok) {
    return {
      ...base,
      status: read.status,
      message:
        read.status === "manual"
          ? `${read.message}. Remove "${MCP_SERVER_NAME}" from "${target.container}" yourself.`
          : read.message,
    };
  }
  const servers = read.data[target.container];
  if (!isPlainObject(servers) || !Object.hasOwn(servers, MCP_SERVER_NAME)) {
    return { ...base, status: "not_present" };
  }
  if (read.symlink) {
    return {
      ...base,
      status: "manual",
      message: `${target.path} is a symlink to ${read.symlink}; left as is. Remove "${MCP_SERVER_NAME}" from "${target.container}" yourself.`,
    };
  }
  if (dryRun) return { ...base, status: "removed" };

  delete servers[MCP_SERVER_NAME];
  try {
    writeConfig(target.path, JSON.stringify(read.data, null, 2) + "\n", true, read.mode);
  } catch (err) {
    return { ...base, status: "failed", message: (err as Error).message };
  }
  return { ...base, status: "removed" };
}

/** Atomic write; the first time an existing file is changed, a copy goes to `<file>.opendocs-backup`. */
function writeConfig(file: string, content: string, existed: boolean, mode: number): void {
  if (existed) backupOnce(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content, mode);
}

function backupOnce(file: string): void {
  try {
    fs.copyFileSync(file, file + BACKUP_SUFFIX, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

// ── Codex config.toml ───────────────────────────────────────────────────

const CODEX_TABLE = `mcp_servers.${MCP_SERVER_NAME}`;
const CODEX_LOGIN = `codex mcp login ${MCP_SERVER_NAME}`;

interface CodexEntry {
  /** An `opendocs` server is defined in any form. */
  present: boolean;
  url?: string;
  /** Index of the `[mcp_servers.opendocs]` header line, if it's a table. */
  tableLine?: number;
  /** `mcp_servers = { ... }` inline: a new table can't be added next to it. */
  inline: boolean;
}

/**
 * Finds the opendocs server in a Codex config.toml without a TOML parser:
 * table headers and `key = value` lines, skipping multi-line strings.
 */
export function findCodexEntry(text: string): CodexEntry {
  const lines = text.split(/\r?\n/);
  const entry: CodexEntry = { present: false, inline: false };
  let section = "";
  let inString: '"""' | "'''" | null = null;
  lines.forEach((line, index) => {
    if (inString) {
      if (countOf(line, inString) % 2 === 1) inString = null;
      return;
    }
    if (/^\s*\[\[/.test(line)) {
      section = "[[array]]";
      return;
    }
    const header = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = tomlKey(header[1]);
      if (section === CODEX_TABLE) {
        entry.present = true;
        entry.tableLine ??= index;
      }
      return;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_\-."' ]+?)\s*=\s*(.*)$/);
    if (!kv) return;
    for (const quote of ['"""', "'''"] as const) {
      if (countOf(kv[2], quote) % 2 === 1) inString = quote;
    }
    if (section === "[[array]]") return;
    const key = section ? `${section}.${tomlKey(kv[1])}` : tomlKey(kv[1]);
    if (key === "mcp_servers") entry.inline = true;
    if (key === CODEX_TABLE) {
      // opendocs = { url = "..." } under [mcp_servers]
      entry.present = true;
      const inner = kv[2].match(/\burl\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
      if (inner) entry.url = tomlString(inner[1]);
    }
    if (key.startsWith(`${CODEX_TABLE}.`)) entry.present = true;
    if (key === `${CODEX_TABLE}.url`) entry.url = tomlString(kv[2]);
  });
  return entry;
}

function addToCodex(file: string, url: string, dryRun: boolean): Outcome<McpAddStatus> {
  const base = { method: "config" as const, path: file };
  const snippet = `[${CODEX_TABLE}] url = ${JSON.stringify(url)}`;
  const st = lstatOrNull(file);
  const symlink = st?.isSymbolicLink() ? linkTarget(file) : undefined;
  const real = symlink ? statOrNull(file) : st;
  if (real && !real.isFile()) return { ...base, status: "failed", message: `${file} exists and is not a file` };

  const text = real ? fs.readFileSync(file, "utf8") : "";
  const entry = findCodexEntry(text);
  const signIn = `Sign in with: ${CODEX_LOGIN}`;
  if (entry.present && sameUrl(entry.url, url)) return { ...base, status: "already_present", message: signIn };
  if (symlink) {
    return {
      ...base,
      status: "manual",
      message: `${file} is a symlink to ${symlink}; left as is. Add ${snippet} yourself.`,
    };
  }
  if (entry.present) {
    return {
      ...base,
      status: "manual",
      message: `${file} already has an "${MCP_SERVER_NAME}" MCP server with another URL; set its url to "${url}".`,
    };
  }
  if (entry.inline) {
    return {
      ...base,
      status: "manual",
      message: `${file} defines mcp_servers inline; add ${MCP_SERVER_NAME} = { url = ${JSON.stringify(url)} } to it yourself.`,
    };
  }
  if (dryRun) return { ...base, status: "added", message: signIn };

  // Append the table; the rest of the file is kept byte for byte.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next = text;
  if (next && !next.endsWith("\n")) next += eol;
  if (next && !/\n[ \t]*\r?\n$/.test(next)) next += eol;
  next += `[${CODEX_TABLE}]${eol}url = ${JSON.stringify(url)}${eol}`;
  try {
    writeConfig(file, next, !!real, real ? real.mode & 0o777 : 0o600);
  } catch (err) {
    return { ...base, status: "failed", message: (err as Error).message };
  }
  return { ...base, status: "added", message: signIn };
}

async function removeFromCodex(file: string, dryRun: boolean, deps: McpDeps): Promise<Outcome<McpRemoveStatus>> {
  const st = lstatOrNull(file);
  const real = st?.isSymbolicLink() ? statOrNull(file) : st;
  const text = real?.isFile() ? fs.readFileSync(file, "utf8") : "";
  const entry = findCodexEntry(text);
  if (!st || !entry.present) return { method: "config", path: file, status: "not_present" };

  // `codex mcp remove` also knows about anything else Codex keeps for it.
  const args = ["mcp", "remove", MCP_SERVER_NAME];
  const command = displayCommand("codex", args);
  const bin = deps.which("codex");
  if (bin) {
    if (dryRun) return { method: "cli", command, status: "removed" };
    const res = await deps.exec(bin, args);
    if (res.code === 0) return { method: "cli", command, status: "removed" };
    if (/no mcp server named/i.test(`${res.stderr}\n${res.stdout}`)) {
      return { method: "cli", command, status: "not_present" };
    }
    return { method: "cli", command, status: "failed", message: failureMessage("codex", res) };
  }

  const base = { method: "config" as const, path: file };
  if (st.isSymbolicLink()) {
    return {
      ...base,
      status: "manual",
      message: `${file} is a symlink to ${linkTarget(file)}; left as is. Remove [${CODEX_TABLE}] from it yourself.`,
    };
  }
  const next = entry.tableLine === undefined ? null : removeTomlTable(text, entry.tableLine);
  if (next === null) {
    return { ...base, status: "manual", message: `Remove the "${MCP_SERVER_NAME}" server from ${file} yourself.` };
  }
  if (dryRun) return { ...base, status: "removed" };
  try {
    writeConfig(file, next, true, (real ?? st).mode & 0o777);
  } catch (err) {
    return { ...base, status: "failed", message: (err as Error).message };
  }
  return { ...base, status: "removed" };
}

/**
 * Cuts the table whose header is on line `start` (and its sub-tables) out
 * of the file. Comments and blank lines just above the next table stay.
 */
function removeTomlTable(text: string, start: number): string | null {
  const lines = text.split(/(?<=\n)/);
  if (start >= lines.length) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?\r?\n?$/);
    if (!header) continue;
    const key = tomlKey(header[1]);
    if (key !== CODEX_TABLE && !key.startsWith(`${CODEX_TABLE}.`)) {
      end = i;
      break;
    }
  }
  if (end < lines.length) {
    while (end > start + 1 && /^\s*(?:#.*)?\r?\n?$/.test(lines[end - 1])) end--;
  } else if (start > 0 && /^\s*\r?\n$/.test(lines[start - 1])) {
    // Our table was last: take the blank line added in front of it too.
    start--;
  }
  return lines.slice(0, start).join("") + lines.slice(end).join("");
}

function tomlKey(raw: string): string {
  return raw
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .join(".");
}

function tomlString(raw: string): string | undefined {
  const value = raw.trim();
  const basic = value.match(/^"((?:[^"\\]|\\.)*)"/);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`) as string;
    } catch {
      return basic[1];
    }
  }
  return value.match(/^'([^']*)'/)?.[1];
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// ── Claude Code and VS Code CLIs ────────────────────────────────────────

async function addToClaude(url: string, dryRun: boolean, deps: McpDeps): Promise<Outcome<McpAddStatus>> {
  const args = ["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, url];
  const command = displayCommand("claude", args);
  const base = { method: "cli" as const, command };
  const bin = deps.which("claude");
  if (!bin) return { ...base, status: "manual", message: "The claude command isn't on PATH; run this command." };

  // Exits 0 and prints "URL: ..." when a server with this name exists in any scope.
  const existing = await deps.exec(bin, ["mcp", "get", MCP_SERVER_NAME]);
  if (existing.code === 0) {
    const current = existing.stdout.match(/^\s*URL:\s*(\S+)/im)?.[1];
    if (!current || sameUrl(current, url)) return { ...base, status: "already_present" };
    return {
      ...base,
      status: "manual",
      command: `claude mcp remove ${MCP_SERVER_NAME} && ${command}`,
      message: `Claude Code already has an "${MCP_SERVER_NAME}" server for ${current}; replace it with this command.`,
    };
  }
  if (dryRun) return { ...base, status: "added" };

  const res = await deps.exec(bin, args);
  if (res.code === 0) return { ...base, status: "added" };
  if (/already exists/i.test(`${res.stderr}\n${res.stdout}`)) return { ...base, status: "already_present" };
  return { ...base, status: "failed", message: failureMessage("claude", res) };
}

async function removeFromClaude(dryRun: boolean, deps: McpDeps): Promise<Outcome<McpRemoveStatus>> {
  const args = ["mcp", "remove", MCP_SERVER_NAME, "-s", "user"];
  const command = displayCommand("claude", args);
  const base = { method: "cli" as const, command };
  const bin = deps.which("claude");
  if (!bin) return { ...base, status: "manual", message: "The claude command isn't on PATH; run this command." };
  if (dryRun) {
    const existing = await deps.exec(bin, ["mcp", "get", MCP_SERVER_NAME]);
    return { ...base, status: existing.code === 0 ? "removed" : "not_present" };
  }
  const res = await deps.exec(bin, args);
  if (res.code === 0) return { ...base, status: "removed" };
  if (/no .*mcp server|not found/i.test(`${res.stderr}\n${res.stdout}`)) return { ...base, status: "not_present" };
  return { ...base, status: "failed", message: failureMessage("claude", res) };
}

async function addToVsCode(
  target: Extract<Target, { kind: "vscode" }>,
  url: string,
  dryRun: boolean,
  deps: McpDeps,
): Promise<Outcome<McpAddStatus>> {
  // Reading is safe either way; it tells us whether there's anything to do.
  const read = readJsonConfig(target.file.path, target.file.container);
  let current: unknown;
  if (read.ok) {
    const servers = read.data[target.file.container];
    current = isPlainObject(servers) && Object.hasOwn(servers, MCP_SERVER_NAME) ? servers[MCP_SERVER_NAME] : undefined;
    if (isPlainObject(current) && sameUrl(current[target.file.urlKey], url)) {
      return { method: "config", path: target.file.path, status: "already_present" };
    }
  }

  const bin = deps.which("code");
  if (bin) {
    const args = ["--add-mcp", JSON.stringify({ name: MCP_SERVER_NAME, ...target.file.entry })];
    const base = { method: "cli" as const, command: displayCommand("code", args) };
    const status = current === undefined ? "added" : "updated";
    if (dryRun) return { ...base, status };
    const res = await deps.exec(bin, args);
    if (res.code === 0) return { ...base, status };
    return { ...base, status: "failed", message: failureMessage("code", res) };
  }
  if (!fs.existsSync(target.userDir)) {
    return {
      method: "config",
      path: target.file.path,
      status: "skipped",
      message: `VS Code not found (no code command on PATH, no ${target.userDir}).`,
    };
  }
  return addToJson(target.file, url, dryRun);
}

// ── Chat apps ───────────────────────────────────────────────────────────

export type ChatApp = "claude" | "chatgpt";
export const CHAT_APPS: ChatApp[] = ["claude", "chatgpt"];

/** The page that adds the server: Claude's prefilled "Add custom connector" dialog, or ChatGPT's plugins page. */
export function chatAppUrl(app: ChatApp, url: string): string {
  if (app === "claude") {
    return (
      "https://claude.ai/customize/connectors?modal=add-custom-connector" +
      `&connectorName=${encodeURIComponent(MCP_DISPLAY_NAME)}&connectorUrl=${encodeURIComponent(url)}`
    );
  }
  return "https://chatgpt.com/plugins";
}

/** Best effort: pbcopy, clip, wl-copy, xclip or xsel. */
export async function copyToClipboard(text: string, deps: McpDeps = defaultMcpDeps()): Promise<boolean> {
  const { platform, env } = deps.ctx;
  const candidates: [string, string[]][] =
    platform === "darwin"
      ? [["pbcopy", []]]
      : platform === "win32"
        ? [["clip", []]]
        : [
            ...(env.WAYLAND_DISPLAY ? ([["wl-copy", []]] as [string, string[]][]) : []),
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [name, args] of candidates) {
    const bin = deps.which(name);
    if (bin && (await deps.pipe(bin, args, text))) return true;
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameUrl(value: unknown, url: string): boolean {
  return typeof value === "string" && value.trim().replace(/\/+$/, "") === url.trim().replace(/\/+$/, "");
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function linkTarget(link: string): string {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return "another location";
  }
}

/** The command as you'd type it in a POSIX shell. */
export function displayCommand(program: string, args: string[]): string {
  const quote = (arg: string) => (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
  return [program, ...args.map(quote)].join(" ");
}

function failureMessage(program: string, res: ExecResult): string {
  // eslint-disable-next-line no-control-regex
  const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).find((l) => l.trim());
  return (
    clean(res.stderr) ??
    clean(res.stdout) ??
    res.error ??
    `${program} exited with code ${res.code ?? "unknown"}`
  ).trim();
}
