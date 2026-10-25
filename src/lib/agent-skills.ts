// Installs the bundled OpenDocs skill (agent/SKILL.md + agent/scripts/opendocs.sh)
// into the global skills folder of each AI coding agent on the machine.
//
// Paths and detection come from each agent's own docs (URLs next to each
// entry) and the agents list in vercel-labs/skills (src/agents.ts). Most
// agents read the shared `~/.agents/skills` folder (agentskills.io's
// cross-client location), so they get one copy there instead of one each:
// a second copy under a different folder shows up twice in some agents
// (Codex lists both). Agents whose docs don't mention `~/.agents/skills`
// get their own folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = "opendocs";

export interface AgentEnv {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function currentAgentEnv(): AgentEnv {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

export interface SkillAgent {
  id: string;
  name: string;
  /** The agent's global skills folder; the skill goes in `<skillsDir>/opendocs`. */
  skillsDir: string;
  /** The agent counts as installed when any of these exists. */
  detectPaths: string[];
}

interface AgentSpec {
  id: string;
  name: string;
  aliases?: string[];
  resolve(ctx: Resolver): { skillsDir: string; detect: string[] };
}

interface Resolver {
  /** Joins onto the home folder. */
  home(...parts: string[]): string;
  join(...parts: string[]): string;
  /** A non-empty environment variable, trimmed. */
  env(name: string): string | undefined;
  /** `$XDG_CONFIG_HOME`, else `~/.config` (on every platform, like opencode and Amp). */
  xdgConfig(...parts: string[]): string;
  /** `~/.agents/skills`, read by most agents. */
  shared: string;
  windows: boolean;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    // code.claude.com/docs/en/skills, code.claude.com/docs/en/claude-directory
    id: "claude-code",
    name: "Claude Code",
    aliases: ["claude"],
    resolve: (r) => {
      const dir = r.env("CLAUDE_CONFIG_DIR") ?? r.home(".claude");
      return { skillsDir: r.join(dir, "skills"), detect: [dir] };
    },
  },
  {
    // developers.openai.com/codex/skills: user skills in $HOME/.agents/skills
    id: "codex",
    name: "Codex",
    resolve: (r) => ({
      skillsDir: r.shared,
      detect: [r.env("CODEX_HOME") ?? r.home(".codex")],
    }),
  },
  {
    // cursor.com/docs/context/skills: user skills in ~/.agents/skills or ~/.cursor/skills
    id: "cursor",
    name: "Cursor",
    resolve: (r) => ({ skillsDir: r.shared, detect: [r.home(".cursor")] }),
  },
  {
    // docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
    // (~/.copilot/skills or ~/.agents/skills); VS Code reads ~/.agents/skills too.
    id: "github-copilot",
    name: "GitHub Copilot",
    aliases: ["copilot"],
    resolve: (r) => ({
      skillsDir: r.shared,
      detect: [r.env("COPILOT_HOME") ?? r.home(".copilot")],
    }),
  },
  {
    // geminicli.com/docs/cli/skills: ~/.gemini/skills or the ~/.agents/skills alias.
    // GEMINI_CLI_HOME replaces the home folder, so use its own folder there.
    id: "gemini-cli",
    name: "Gemini CLI",
    aliases: ["gemini"],
    resolve: (r) => {
      const custom = r.env("GEMINI_CLI_HOME");
      if (custom) {
        const dir = r.join(custom, ".gemini");
        return { skillsDir: r.join(dir, "skills"), detect: [dir] };
      }
      return { skillsDir: r.shared, detect: [r.home(".gemini")] };
    },
  },
  {
    // opencode.ai/docs/skills: ~/.config/opencode/skills, ~/.claude/skills, ~/.agents/skills
    id: "opencode",
    name: "opencode",
    resolve: (r) => ({ skillsDir: r.shared, detect: [r.xdgConfig("opencode")] }),
  },
  {
    // docs.cline.bot/customization/skills: global skills in ~/.cline/skills
    id: "cline",
    name: "Cline",
    resolve: (r) => ({
      skillsDir: r.home(".cline", "skills"),
      detect: [r.home(".cline")],
    }),
  },
  {
    // docs.openclaw.ai/tools/skills: ~/.agents/skills and <state dir>/skills;
    // ~/.agents/skills only with the default state dir (docs.openclaw.ai/help/environment).
    id: "openclaw",
    name: "OpenClaw",
    resolve: (r) => {
      const stateDir = r.env("OPENCLAW_STATE_DIR");
      if (stateDir) return { skillsDir: r.join(stateDir, "skills"), detect: [stateDir] };
      return { skillsDir: r.shared, detect: [r.home(".openclaw")] };
    },
  },
  {
    // hermes-agent.nousresearch.com/docs/user-guide/features/skills,
    // .../docs/reference/environment-variables (HERMES_HOME, %LOCALAPPDATA%\hermes on Windows)
    id: "hermes-agent",
    name: "Hermes Agent",
    aliases: ["hermes"],
    resolve: (r) => {
      const dir =
        r.env("HERMES_HOME") ??
        (r.windows
          ? r.join(r.env("LOCALAPPDATA") ?? r.home("AppData", "Local"), "hermes")
          : r.home(".hermes"));
      return { skillsDir: r.join(dir, "skills"), detect: [dir] };
    },
  },
  {
    // docs.devin.ai/desktop/cascade/skills (was docs.windsurf.com): also discovers ~/.agents/skills
    id: "windsurf",
    name: "Windsurf",
    resolve: (r) => ({ skillsDir: r.shared, detect: [r.home(".codeium", "windsurf")] }),
  },
  {
    // ampcode.com/docs/customize/skills: ~/.config/agents/skills, ~/.agents/skills, ~/.config/amp/skills
    id: "amp",
    name: "Amp",
    resolve: (r) => ({
      skillsDir: r.shared,
      detect: unique([r.xdgConfig("amp"), r.home(".config", "amp")]),
    }),
  },
  {
    // goose-docs.ai/docs/guides/context-engineering/using-skills: global skills in ~/.agents/skills.
    // Config: ~/.config/goose, %APPDATA%\Block\goose on Windows (goose-docs.ai/docs/guides/config-files).
    id: "goose",
    name: "Goose",
    resolve: (r) => {
      const detect = r.windows
        ? [r.join(r.env("APPDATA") ?? r.home("AppData", "Roaming"), "Block", "goose")]
        : [r.xdgConfig("goose")];
      const root = r.env("GOOSE_PATH_ROOT");
      if (root) detect.unshift(root);
      return { skillsDir: r.shared, detect };
    },
  },
  {
    // kiro.dev/docs/skills: global skills in ~/.kiro/skills (IDE and CLI);
    // kiro.dev/docs/configuration: KIRO_HOME (absolute path) moves ~/.kiro.
    id: "kiro-cli",
    name: "Kiro",
    aliases: ["kiro"],
    resolve: (r) => {
      const custom = r.env("KIRO_HOME");
      const dir = custom && path.isAbsolute(custom) ? custom : r.home(".kiro");
      return { skillsDir: r.join(dir, "skills"), detect: [dir] };
    },
  },
  {
    // docs.x.ai/build/features/skills-plugins-marketplaces: ~/.grok/skills and ~/.agents/skills
    id: "grok",
    name: "Grok Build",
    resolve: (r) => ({
      skillsDir: r.shared,
      detect: [r.env("GROK_HOME") ?? r.home(".grok")],
    }),
  },
];

export const AGENT_IDS: string[] = AGENT_SPECS.map((spec) => spec.id);

export function resolveAgents(ctx: AgentEnv = currentAgentEnv()): SkillAgent[] {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const env = (name: string) => {
    const value = ctx.env[name]?.trim();
    return value ? value : undefined;
  };
  const xdg = env("XDG_CONFIG_HOME") ?? p.join(ctx.home, ".config");
  const resolver: Resolver = {
    home: (...parts) => p.join(ctx.home, ...parts),
    join: (...parts) => p.join(...parts),
    env,
    xdgConfig: (...parts) => p.join(xdg, ...parts),
    shared: p.join(ctx.home, ".agents", "skills"),
    windows: ctx.platform === "win32",
  };
  return AGENT_SPECS.map((spec) => {
    const { skillsDir, detect } = spec.resolve(resolver);
    return { id: spec.id, name: spec.name, skillsDir, detectPaths: detect };
  });
}

/** Maps an id or alias (`claude`, `copilot`, `gemini`, ...) to an agent id. */
export function normalizeAgentId(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  const spec = AGENT_SPECS.find((s) => s.id === value || s.aliases?.includes(value));
  return spec?.id;
}

export function isAgentDetected(agent: SkillAgent): boolean {
  return agent.detectPaths.some((p) => fs.existsSync(p));
}

// ── Writing the skill folder ────────────────────────────────────────────

export interface SkillFile {
  /** Path inside the skill folder, with forward slashes (`scripts/opendocs.sh`). */
  path: string;
  content: string;
  executable?: boolean;
}

export type InstallStatus = "installed" | "updated" | "unchanged";

export type InstallOutcome =
  | { ok: true; status: InstallStatus }
  | {
      ok: false;
      reason: "symlink" | "not_a_folder" | "write_failed";
      message: string;
      /** For `symlink`: where the link points. */
      linkTarget?: string;
    };

/**
 * Writes `files` into `dir` (the skill folder itself, e.g. `~/.agents/skills/opendocs`).
 * Only ever writes those files inside `dir`: nothing is deleted, and a
 * folder or file that is a symlink is left alone and reported, so the
 * install can't write somewhere else through it. Files whose content (and
 * executable bit) already match are not touched, so re-running is a no-op.
 *
 * `followDirSymlink` lets an explicit `--install <dir>` point at a symlink.
 */
export function installSkillFolder(
  dir: string,
  files: SkillFile[],
  options: { followDirSymlink?: boolean } = {},
): InstallOutcome {
  const dirStat = lstatOrNull(dir);
  if (dirStat?.isSymbolicLink() && !options.followDirSymlink) {
    return symlinkOutcome(dir);
  }
  if (dirStat && !dirStat.isSymbolicLink() && !dirStat.isDirectory()) {
    return { ok: false, reason: "not_a_folder", message: `${dir} exists and is not a folder` };
  }

  // Check everything before writing anything.
  const plan: { target: string; file: SkillFile; write: boolean; chmod: boolean }[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const sub = path.join(dir, ...parts.slice(0, i));
      const st = lstatOrNull(sub);
      if (st?.isSymbolicLink()) return symlinkOutcome(sub);
      if (st && !st.isDirectory()) {
        return { ok: false, reason: "not_a_folder", message: `${sub} exists and is not a folder` };
      }
    }
    const target = path.join(dir, ...parts);
    const st = lstatOrNull(target);
    if (st?.isSymbolicLink()) return symlinkOutcome(target);
    if (st && !st.isFile()) {
      return { ok: false, reason: "not_a_folder", message: `${target} exists and is not a file` };
    }
    const current = st ? fs.readFileSync(target, "utf8") : null;
    const write = current !== file.content;
    const chmod =
      !write && !!file.executable && process.platform !== "win32" && !!st && (st.mode & 0o111) === 0;
    plan.push({ target, file, write, chmod });
  }

  const hadSkill = fs.existsSync(path.join(dir, "SKILL.md"));
  if (plan.every((step) => !step.write && !step.chmod)) {
    return { ok: true, status: "unchanged" };
  }

  try {
    for (const step of plan) {
      if (step.write) {
        fs.mkdirSync(path.dirname(step.target), { recursive: true });
        writeFileAtomic(step.target, step.file.content, step.file.executable ? 0o755 : 0o644);
      } else if (step.chmod) {
        fs.chmodSync(step.target, 0o755);
      }
    }
  } catch (err) {
    return { ok: false, reason: "write_failed", message: (err as Error).message };
  }
  return { ok: true, status: hadSkill ? "updated" : "installed" };
}

/**
 * The path with any symlinks in the part that already exists resolved, so
 * `~/.claude/skills -> ~/.agents/skills` setups write the folder once.
 */
export function realTarget(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function writeFileAtomic(target: string, content: string, mode: number): void {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function symlinkOutcome(link: string): InstallOutcome {
  let target: string | undefined;
  try {
    target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    target = undefined;
  }
  return {
    ok: false,
    reason: "symlink",
    message: `${link} is a symlink to ${target ?? "another location"}; left as is`,
    linkTarget: target,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
