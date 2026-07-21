import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.live.test.ts"],
      // Ratcheted line-coverage floor (ENG-255 convention): set at/just below
      // the measured value (88.62%). The remaining gap is entirely
      // sdk-seam.ts's `loadSdk`/`createSdkQuery` — the one place that
      // touches the real Agent SDK via a dynamic import, deliberately
      // exercised only by the gated engine.live.test.ts, never by a
      // scripted unit test (see that file's own seam-boundary comment).
      thresholds: { lines: 88 },
    },
  },
});
