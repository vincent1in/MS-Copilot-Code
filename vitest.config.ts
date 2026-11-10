import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Every test file runs with non-loopback network blocked (scripts/net-guard.cjs):
    // the suite drives a stub server on 127.0.0.1, and anything else is a bug.
    setupFiles: ["./test/net-guard.setup.ts"],
    // The M365 protocol is inherently sequential (their AGENTS.md: the rate limit
    // tracks threads-started, not messages). Our stub-server tests bind real ports,
    // so keep them serialised too — it makes port collisions impossible.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
