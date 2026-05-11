import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Subprocess invocations + a real tsc build on first run can be
    // slow on cold caches.
    testTimeout: 30_000,
  },
});
