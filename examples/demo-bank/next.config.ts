import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Served in place at demos.vendo.run/maple — see ./src/lib/base-path.
  basePath: BASE_PATH,
  // The apps engine syntax-checks generated islands with esbuild (native
  // binary) — keep it out of the Turbopack server bundle. PGlite's Emscripten
  // module breaks under Turbopack's production chunking ("f.instantiateWasm
  // is not a function"), so it stays external too — including @vendoai/store,
  // which loads PGlite for the local default store.
  serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/store"],
  transpilePackages: ["@vendoai/ui"],
  // Dev-only: resolve @vendoai/ui to its TypeScript source so edits in
  // packages/ui/src hot-reload here instead of waiting on a `pnpm build`.
  // Turbopack matches the request verbatim, so every entry point in the
  // package's exports map needs its own line — and its NodeNext `.js`
  // specifiers only resolve to `.ts` because this app's tsconfig is NodeNext
  // too. `next build` skips the block and resolves dist/ like a published
  // install would.
  ...(process.env.NODE_ENV === "development"
    ? {
        turbopack: {
          resolveAlias: {
            "@vendoai/ui": "../../packages/ui/src/index.ts",
            "@vendoai/ui/chrome": "../../packages/ui/src/chrome/index.ts",
            "@vendoai/ui/tree": "../../packages/ui/src/tree/index.ts",
            "@vendoai/ui/kit": "../../packages/ui/src/kit/index.ts",
          },
        },
      }
    : {}),
  // Test boots (away-drill e2e) get their own dist dir → own dev-server lock,
  // so they never fight a concurrent `pnpm dev`. Nested under .next so
  // gitignore/scanner rules that skip .next cover it.
  ...(process.env.MAPLE_DIST_DIR ? { distDir: process.env.MAPLE_DIST_DIR } : {}),
  // Dev-only: allow the local TLS front (e.g. https://127.0.0.1:8443 for
  // broker-fronted MCP verification) to load dev resources; without this,
  // Next blocks cross-origin dev assets and pages served through the front
  // never hydrate. No effect on production builds.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
