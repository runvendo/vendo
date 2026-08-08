import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      // auth-presets/* are one-line re-exports mirroring @vendoai/vendo's
      // per-preset subpaths; alias.test.ts asserts the export map instead.
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}", "src/auth-presets/**"],
      // NO line-coverage floor here, deliberately. Once auth-presets/* is
      // excluded this package is 4 measured lines, 2 of them covered: the
      // highest floor that could tolerate even 20 new uncovered lines is 8%, so
      // any percentage here is decorative rather than a gate. Coverage is still
      // REPORTED (the reporter above) — there is just nothing honest to enforce
      // on an alias shim. Don't add a number back without lines to back it.
    },
  },
});
