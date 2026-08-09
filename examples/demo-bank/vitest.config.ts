import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    // Worker caps live in config, not in the root `test` scripts: a cap in a
    // command line only applies when someone types that command, so a bare
    // `npx vitest`, an IDE runner and a debug run all escaped it. Env
    // (VITEST_MIN/MAX_FORKS, VITEST_MIN/MAX_THREADS) still wins, so CI is
    // unchanged. Both halves are required: vitest 2.1 defaults the min to the
    // CPU count independently of the max, and a max-only cap makes Tinypool
    // throw `minThreads and maxThreads must not conflict` before any test runs.
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
      threads: { minThreads: 1, maxThreads: 2 },
    },
    environment: "node", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Force one React instance across the host and Vendo UI in jsdom.
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime"),
    },
  },
})
