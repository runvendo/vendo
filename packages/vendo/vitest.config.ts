import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every umbrella test composes the full stack (createVendo → real PGlite
    // store + agent + guard + apps + automations) and, for the wire tests,
    // streams a turn end to end. Turbo runs this suite concurrently with every
    // other package's tests, so on a loaded CI runner these full-stack tests can
    // starve well past vitest's 5s default (≈11s local, ≈90s for the suite under
    // CI contention). 30s absorbs the contention without masking a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
