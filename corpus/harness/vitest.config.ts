import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The harness exercises real git repositories and process trees. Those
    // tests can exceed Vitest's 5s default when Turbo runs every workspace in
    // parallel, even though the operations themselves are bounded.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
