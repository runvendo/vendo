import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted line-coverage floor (ENG-255): set at/just below the measured
      // value so it can only rise. Regression below this fails CI.
      thresholds: { lines: 75 },
    },
    environment: "jsdom",
    include: ["test/**/*.test.ts?(x)"],
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      // Resolve `fluidkit` to an inert stub in EVERY ui test, so no test worker
      // ever loads the real decorative animation library (or its `motion`
      // peer). Two flake hazards this removes package-wide:
      //   1. motion's frameloop keeps a rAF outstanding; under jsdom that rAF is
      //      a Node `setInterval` that survives vitest's environment teardown
      //      and dereferences a stripped `window` -> unhandled "window is not
      //      defined".
      //   2. The first dynamic import triggers vite's in-worker transform of the
      //      fluidkit+motion chunk (multi-second on loaded CI), stalling the
      //      worker past `findBy*` windows and timing out unrelated assertions.
      // fluidkit is not under test in this package; the stub is faithful (the
      // presence is decorative and `aria-hidden`). See test/mocks/fluidkit.tsx.
      fluidkit: fileURLToPath(new URL("./test/mocks/fluidkit.tsx", import.meta.url)),
    },
  },
});
