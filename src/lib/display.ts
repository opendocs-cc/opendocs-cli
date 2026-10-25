import os from "node:os";
import path from "node:path";

// Small helpers for human-readable tables of paths (agent --install, mcp add).

/** `~/...` for paths inside the home folder. */
export function tildify(target: string): string {
  const home = os.homedir();
  if (target === home) return "~";
  return target.startsWith(home + path.sep) ? `~${target.slice(home.length)}` : target;
}

/** Replaces the home folder with `~` everywhere in a message. */
export function tildifyText(text: string): string {
  const home = os.homedir();
  return home.length > 1 ? text.split(home + path.sep).join(`~${path.sep}`) : text;
}

/** Pads every column but the last so the rows line up. */
export function formatColumns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])))
      .join("   ")
      .trimEnd(),
  );
}
