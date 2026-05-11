import { defineConfig } from "vitest/config";

// Tests live alongside the template's lib/ utilities. They run in the
// monorepo CI; the SCAFFOLD_SKIP list in @oak/core/publish-branch keeps
// them out of users' vaults.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
