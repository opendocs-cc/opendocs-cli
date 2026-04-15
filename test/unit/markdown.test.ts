import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readMarkdownFile } from "../../src/lib/markdown.js";

/**
 * readMarkdownFile has two jobs:
 *   1. Read a file off disk, throwing a useful error if it's missing.
 *   2. Extract the first H1 for display purposes (shown in publish output).
 *
 * It resolves paths relative to process.cwd(), so tests chdir into a tmpdir
 * and exercise relative paths the same way a user does.
 */

describe("lib/markdown", () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-md-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads content and extracts first H1 as title", () => {
    fs.writeFileSync("post.md", "# Hello World\n\nBody text here.\n");
    const result = readMarkdownFile("post.md");
    expect(result.content).toBe("# Hello World\n\nBody text here.\n");
    expect(result.title).toBe("Hello World");
  });

  test("returns null title when no H1 is present", () => {
    fs.writeFileSync("no-title.md", "Just a paragraph.\n## Subheading\n");
    const result = readMarkdownFile("no-title.md");
    expect(result.title).toBeNull();
    expect(result.content).toContain("Just a paragraph");
  });

  test("picks the FIRST H1 if multiple are present", () => {
    fs.writeFileSync("multi-h1.md", "# First\n\n# Second\n");
    expect(readMarkdownFile("multi-h1.md").title).toBe("First");
  });

  test("trims surrounding whitespace from the title", () => {
    fs.writeFileSync("spaced.md", "#    Spacey Title    \n");
    expect(readMarkdownFile("spaced.md").title).toBe("Spacey Title");
  });

  test("ignores H2/H3 when extracting title", () => {
    fs.writeFileSync("h2.md", "## Not a title\n### Also not\n");
    expect(readMarkdownFile("h2.md").title).toBeNull();
  });

  test("throws a clear error when the file is missing", () => {
    expect(() => readMarkdownFile("./nope.md")).toThrow(/File not found/);
    expect(() => readMarkdownFile("./nope.md")).toThrow(/nope\.md/);
  });

  test("accepts absolute paths too", () => {
    const abs = path.join(tmpDir, "abs.md");
    fs.writeFileSync(abs, "# Absolute\n");
    expect(readMarkdownFile(abs).title).toBe("Absolute");
  });
});
