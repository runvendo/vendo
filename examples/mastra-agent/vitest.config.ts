import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    // The fixture builds a real PGlite store in a fresh mkdtemp dir and drives
    // real Mastra agent turns over scripted models — give the WASM init room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
