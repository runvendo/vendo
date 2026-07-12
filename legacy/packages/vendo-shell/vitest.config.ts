import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./vitest.setup.ts"],
    // Full-thread renders (VendoThread/approval-resume/slot) under parallel
    // monorepo load can outrun vitest's 5s default even with async-util
    // headroom bumped above — give the whole test body more room too.
    testTimeout: 30_000,
  },
});
