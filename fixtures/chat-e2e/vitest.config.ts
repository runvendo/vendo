import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts", "src/**/*.test.ts"],
    // Each test builds its own PGlite store in a fresh mkdtemp dir — no shared
    // server, no fixed ports — so files are safe to run in parallel. Give the
    // first PGlite WASM init and the multi-turn scripted runs room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
