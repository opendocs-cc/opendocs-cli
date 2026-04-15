import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Commands spawn `tsx` subprocesses and many tests poke at the in-process
    // mock API server on a shared port range. Run serially so ports / temp
    // dirs / recorded request lists never collide.
    fileParallelism: false,
    maxWorkers: 1,
    // tsx cold-start is ~300ms per CLI invocation, so we pad the default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
