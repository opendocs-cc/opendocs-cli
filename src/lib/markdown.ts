import fs from "node:fs";
import path from "node:path";

export function readMarkdownFile(filePath: string): {
  content: string;
  title: string | null;
} {
  const resolved = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolved, "utf-8");

  // Extract first H1 heading for display purposes
  const match = content.match(/^#\s+(.+)$/m);
  const title = match ? match[1].trim() : null;

  return { content, title };
}
