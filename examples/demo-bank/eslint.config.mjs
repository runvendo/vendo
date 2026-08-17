import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Every test dev server's dist dir (MAPLE_DIST_DIR: fixtures/context-e2e,
    // tests/vendo/away-drill). Each is a SIBLING of `.next` and not a child
    // (CLAUDE.md: `next build` wipes its whole distDir), which is exactly why
    // the `.next/**` line above does not already cover them. Matched by glob,
    // not enumerated: `pnpm test` leaves these compiled bundles on disk, and a
    // release's `pnpm lint` ran over `.next-away-drill` and failed (v0.27.0).
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Built sandbox bundles copied into public/ at build time (git-ignored).
    "public/vendo/**",
    "vendo-sandbox/dist/**",
    ".vendo/env/**",
  ]),
]);

export default eslintConfig;
