import { defineConfig } from "vitest/config";
import { workerCaps } from "../../vitest.shared.js";

export default defineConfig({
  test: {
    ...workerCaps,
    include: ["e2e/**/*.e2e.test.ts"],
    // The fixture builds a real PGlite store in a fresh mkdtemp dir and drives
    // real Mastra agent turns over scripted models — give the WASM init room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
