import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { makeRunCli, type RunCli } from "../helpers/run-cli.js";

describe("commands: agent", () => {
  let harness: ReturnType<typeof makeRunCli>;
  let run: RunCli;

  beforeEach(() => {
    harness = makeRunCli();
    run = harness.run;
  });

  afterEach(() => {
    harness.cleanup();
  });

  test("prints concise agent guide by default without auth", async () => {
    const result = await run(["agent"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# OpenDocs Agent Guide");
    expect(result.stdout).toContain("opendocs publish ./docs");
    expect(result.stdout).toContain("Batch publish can partially fail");
    expect(result.stderr).toBe("");
  });

  test("--api prints API-only reference", async () => {
    const result = await run(["agent", "--api"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# OpenDocs Public API Agent Reference");
    expect(result.stdout).toContain("POST /api/v1/publish/batch");
    expect(result.stdout).not.toContain("# OpenDocs CLI Agent Reference");
  });

  test("--cli prints CLI-only reference", async () => {
    const result = await run(["agent", "--cli"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# OpenDocs CLI Agent Reference");
    expect(result.stdout).toContain("opendocs workspace use <slug>");
    expect(result.stdout).not.toContain("# OpenDocs Public API Agent Reference");
  });

  test("--full prints bundled SKILL.md", async () => {
    const result = await run(["agent", "--full"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("name: opendocs");
    expect(result.stdout).toContain("# OpenDocs");
    expect(result.stdout).toContain("Public API quick reference");
  });

  test("--json wraps the selected guide", async () => {
    const result = await run(["--json", "agent", "--api"]);

    expect(result.exitCode).toBe(0);
    expect(result.json()).toMatchObject({
      variant: "api",
      version: expect.any(String),
      content: expect.stringContaining("POST /api/v1/publish"),
    });
  });

  test("rejects multiple guide variants", async () => {
    const result = await run(["--json", "agent", "--api", "--cli"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "conflicting_options",
    });
  });
});
