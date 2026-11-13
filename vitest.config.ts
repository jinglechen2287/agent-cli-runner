import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This checkout's tests only. Worktrees nested under .claude/ hold their
    // own copies, whose module mocks would miss this checkout's dependencies.
    include: ["tests/**/*.test.ts"],
  },
});
