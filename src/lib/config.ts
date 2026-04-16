import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CliConfig {
  apiKey: string;
  apiUrl: string;
  userId?: string;
  username?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
}

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || path.join(os.homedir(), ".config");
  return path.join(base, "opendocs");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig(): CliConfig | null {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getConfigPath();
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearConfig(): void {
  try {
    fs.unlinkSync(getConfigPath());
  } catch {
    // Already gone
  }
}

export function getConfigOrExit(): CliConfig {
  const config = loadConfig();
  if (!config) {
    console.error(
      'Not logged in. Run "opendocs login" to authenticate with your API key.',
    );
    process.exit(1);
  }
  return config;
}
