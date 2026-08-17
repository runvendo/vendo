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
    // fixtures/context-e2e's dev server. Its dist dir is a SIBLING of `.next`
    // and not a child (CLAUDE.md: `next build` wipes its whole distDir), which
    // is exactly why the `.next/**` line above does not already cover it.
    ".next-context-e2e/**",
    // The away-drill fixture's dev server, same rule and same reason: its dist
    // dir (MAPLE_DIST_DIR=.next-away-drill) is a SIBLING of `.next`, so nothing
    // above covers it. Release's publish job runs the browser tests and THEN
    // `pnpm lint`, so an unignored artifact dir aborts the publish.
    ".next-away-drill/**",
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
