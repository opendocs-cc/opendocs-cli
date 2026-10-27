import { Command } from "commander";
import {
  CHAT_APPS,
  CHATGPT_PLUGIN_URL,
  MCP_AGENT_IDS,
  MCP_DISPLAY_NAME,
  MCP_GUIDE_URL,
  MCP_SERVER_NAME,
  addMcpServer,
  chatAppUrl,
  copyToClipboard,
  mcpAgentNames,
  mcpServerUrl,
  removeMcpServer,
  type ChatApp,
  type McpAddStatus,
  type McpRemoveStatus,
  type McpResult,
  type McpRun,
} from "../lib/mcp.js";
import { openBrowser } from "../lib/browser.js";
import { formatColumns, tildify, tildifyText } from "../lib/display.js";
import { brand, createOutput, type Output } from "../lib/output.js";

/**
 * `opendocs mcp …` — the remote OpenDocs MCP server for chat apps and AI
 * tools: print its URL, register it in the coding tools on this machine
 * (lib/mcp.ts does the work), or open Claude / ChatGPT to add it there.
 */
export const mcpCommand = new Command("mcp")
  .description("Connect Claude, ChatGPT and AI coding tools to the OpenDocs MCP server")
  .addHelpText(
    "after",
    `
The OpenDocs MCP server lets chat apps and agents publish and read your docs.
Each tool signs you in to OpenDocs the first time it uses it; no API key is
stored anywhere.

Examples:
  opendocs mcp url                       # ${mcpServerUrl()}
  opendocs mcp add                       # every coding tool found on this machine
  opendocs mcp add --agent cursor codex  # only these
  opendocs mcp add --dry-run             # show what would change
  opendocs mcp connect claude            # add it to the Claude app
  opendocs mcp connect chatgpt
  opendocs mcp remove

Guide: ${MCP_GUIDE_URL}
`,
  )
  .action((_opts, cmd) => {
    if (cmd.optsWithGlobals().json) {
      printUrl(cmd);
      return;
    }
    cmd.outputHelp();
  });

mcpCommand
  .command("url")
  .description("Print the OpenDocs MCP server URL")
  .action((_opts, cmd) => printUrl(cmd));

function printUrl(cmd: Command): void {
  const out = createOutput(cmd.optsWithGlobals().json);
  const url = mcpServerUrl();
  if (cmd.optsWithGlobals().json) {
    out.result({ url, name: MCP_SERVER_NAME, displayName: MCP_DISPLAY_NAME });
    return;
  }
  process.stdout.write(`${url}\n`);
}

const agentHelp = `Only these tools, even if not detected (${MCP_AGENT_IDS.join(", ")})`;

mcpCommand
  .command("add")
  .description("Register the OpenDocs MCP server in the AI coding tools on this machine")
  .option("--agent <ids...>", agentHelp)
  .option("--all", "Every detected tool (the default)")
  .option("--dry-run", "Show what would change without changing anything")
  .addHelpText(
    "after",
    `
Uses each tool's own CLI when it's on PATH (claude, code), otherwise merges
the server into its MCP config file. Config files that aren't plain JSON
(comments, trailing commas) or are symlinks are left alone and you get the
line to add instead. The first change to an existing file keeps a copy next
to it as <file>.opendocs-backup.
`,
  )
  .action(async (opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    await runMcp(out, cmd.optsWithGlobals().json, "add", opts);
  });

mcpCommand
  .command("remove")
  .alias("rm")
  .description("Remove the OpenDocs MCP server from the AI coding tools on this machine")
  .option("--agent <ids...>", agentHelp)
  .option("--all", "Every detected tool (the default)")
  .option("--dry-run", "Show what would change without changing anything")
  .action(async (opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    await runMcp(out, cmd.optsWithGlobals().json, "remove", opts);
  });

async function runMcp(
  out: Output,
  json: boolean,
  mode: "add" | "remove",
  opts: { agent?: string[]; all?: boolean; dryRun?: boolean },
): Promise<void> {
  if (opts.all && opts.agent) {
    out.error({ code: "conflicting_options", message: "Use either --all or --agent <ids...>, not both." });
    return;
  }
  try {
    out.spin(mode === "add" ? "Registering the OpenDocs MCP server..." : "Removing the OpenDocs MCP server...");
    const options = { agents: opts.agent, dryRun: opts.dryRun };
    const run = mode === "add" ? await addMcpServer(options) : await removeMcpServer(options);
    out.stopSpinner();
    if (run.results.some((r) => r.status === "failed")) process.exitCode = 1;
    if (json) {
      out.result(run);
      return;
    }
    printMcpResults(run, mode);
  } catch (err) {
    out.error(err as { code?: string; message: string });
  }
}

mcpCommand
  .command("connect")
  .description("Add the OpenDocs MCP server to the Claude or ChatGPT app (opens the browser)")
  .argument("<app>", CHAT_APPS.join(" | "))
  .addHelpText(
    "after",
    `
Opens the page that adds OpenDocs.cc (Claude's custom connector dialog, or
the OpenDocs.cc plugin in ChatGPT's directory) and copies the server URL to
the clipboard. With --json, prints { app, openUrl, url, copied } and doesn't
open a browser.
`,
  )
  .action(async (appArg: string, _opts, cmd) => {
    const json = cmd.optsWithGlobals().json;
    const out = createOutput(json);
    const app = appArg.trim().toLowerCase() as ChatApp;
    if (!CHAT_APPS.includes(app)) {
      out.error({ code: "unknown_app", message: `Unknown app "${appArg}". Use ${CHAT_APPS.join(" or ")}.` });
      return;
    }
    const url = mcpServerUrl();
    const openUrl = chatAppUrl(app, url);
    const copied = await copyToClipboard(url);
    if (json) {
      out.result({ app, openUrl, url, copied });
      return;
    }

    const lines = [`Opening ${brand.url(openUrl)}`, ""];
    if (app === "claude") {
      lines.push(
        `  1. Check the name (${MCP_DISPLAY_NAME}) and URL (${url}), then click Add.`,
        `  2. Click Connect and sign in to OpenDocs.`,
      );
    } else if (openUrl === CHATGPT_PLUGIN_URL) {
      lines.push(
        `  1. Click "Install plugin".`,
        `  2. Sign in to OpenDocs and click Allow.`,
        "",
        brand.muted(
          `Can't install it? In Settings → Plugins, click "+", choose "Add custom MCP server" and name it ${MCP_DISPLAY_NAME}.`,
        ),
      );
    } else {
      lines.push(
        `  1. Click "+" and choose "Add custom MCP server".`,
        `  2. Name: ${MCP_DISPLAY_NAME}   URL: ${url}`,
        `  3. Sign in to OpenDocs when ChatGPT asks.`,
      );
    }
    lines.push(
      "",
      copied
        ? brand.muted(`The URL is on your clipboard: ${url}`)
        : brand.muted(`Server URL: ${url}`),
    );
    process.stdout.write(lines.join("\n") + "\n");
    await openBrowser(openUrl);
  });

// ── Human output ────────────────────────────────────────────────────────

const STATUS_LABELS: Record<McpAddStatus | McpRemoveStatus, string> = {
  added: "added",
  updated: "updated",
  already_present: "already present",
  manual: "manual",
  skipped: "skipped",
  failed: "failed",
  removed: "removed",
  not_present: "not present",
};

const NEEDS_ATTENTION = new Set(["manual", "skipped", "failed"]);

/** One row per tool: name, status, then the file or command (or what to do). */
export function printMcpResults(
  run: McpRun<McpAddStatus> | McpRun<McpRemoveStatus>,
  mode: "add" | "remove",
): void {
  const results = run.results as McpResult[];
  const lines: string[] = [];
  lines.push(`OpenDocs MCP server: ${brand.url(run.url)}`);
  if (run.dryRun) lines.push(brand.muted("Dry run: nothing was changed."));
  lines.push("");

  if (results.length === 0) {
    lines.push(
      "No supported tools found.",
      `Pick one anyway with ${brand.purple(`opendocs mcp ${mode} --agent <id>`)} (ids: ${MCP_AGENT_IDS.join(", ")}).`,
    );
    if (mode === "add") {
      lines.push(
        `For the Claude or ChatGPT app: ${brand.purple("opendocs mcp connect claude")} (or ${brand.purple("chatgpt")}).`,
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  const rows: string[][] = [];
  for (const r of results) {
    const attention = NEEDS_ATTENTION.has(r.status);
    const where = r.path ? tildify(r.path) : r.command;
    const main = attention ? (r.message ?? r.command ?? where ?? "") : (where ?? "");
    rows.push([r.name, STATUS_LABELS[r.status as McpAddStatus | McpRemoveStatus] ?? r.status, tildifyText(main)]);
    if (attention && r.message && r.command) rows.push(["", "", r.command]);
    else if (!attention && r.message) rows.push(["", "", tildifyText(r.message)]);
  }
  for (const row of formatColumns(rows)) lines.push(`  ${row}`);

  const names = mcpAgentNames();
  const notFound = run.notDetected.map((id) => names.get(id) ?? id);
  if (notFound.length > 0) lines.push("", brand.muted(`  Not found: ${notFound.join(", ")}`));

  const changed = results.some((r) => r.status === "added" || r.status === "updated" || r.status === "removed");
  if (changed && !run.dryRun) {
    lines.push("", "Restart your tools (or start a new session) to pick up the change.");
  }
  if (mode === "add") lines.push("", "Sign in from each tool the first time it uses OpenDocs.");
  process.stdout.write(lines.join("\n") + "\n");
}
