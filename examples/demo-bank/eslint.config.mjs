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
