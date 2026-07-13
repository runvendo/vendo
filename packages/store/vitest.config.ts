import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    // Dual-backend PGlite/Postgres CRUD + a SIGKILL durability drill; under CI
    // cross-package parallelism these can starve past vitest's 5s default. 15s
    // absorbs the contention without masking a real hang.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
