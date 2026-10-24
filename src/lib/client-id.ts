// Which agent or tool is driving the CLI, sent as `X-OpenDocs-Client` so
// the dashboard and version history can show "via Claude Code" etc.
// Precedence: `--client` flag, OPENDOCS_CLIENT, then best-effort detection
// from environment variables the common harnesses set.

let explicitClient: string | undefined;

export function setClientName(name: string | undefined) {
  explicitClient = name?.trim() || undefined;
}

const DETECTORS: Array<[string, () => boolean]> = [
  ["claude-code", () => process.env.CLAUDECODE === "1" || Boolean(process.env.CLAUDE_CODE_ENTRYPOINT)],
  ["cursor", () => Boolean(process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID)],
  ["codex", () => Boolean(process.env.CODEX_SANDBOX || process.env.CODEX_MANAGED_BY_NPM)],
  ["gemini", () => Boolean(process.env.GEMINI_CLI)],
  ["opencode", () => Boolean(process.env.OPENCODE)],
];

export function getClientName(): string {
  const configured = explicitClient ?? process.env.OPENDOCS_CLIENT?.trim();
  if (configured) return configured.toLowerCase();
  for (const [name, matches] of DETECTORS) {
    if (matches()) return name;
  }
  return "opendocs-cli";
}
