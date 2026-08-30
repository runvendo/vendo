import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Served in place at demos.vendo.run/maple — see ./src/lib/base-path.
  basePath: BASE_PATH,
  // @vendoai/vendo is the load-bearing entry: its engine syntax-checks generated
  // islands with esbuild through a VARIABLE specifier the bundler cannot see, so
  // an "esbuild" entry alone is inert — bundle the package and that import
  // becomes a bare resolve from this app's root. It only ever worked here
  // because the monorepo root hoists esbuild. The same package holds the store
  // that loads PGlite, whose Emscripten module breaks under Turbopack's
  // production chunking ("f.instantiateWasm is not a function"), so one entry
  // now covers both reasons. It is dev-conditional because the dev block below
  // aliases the umbrella to source and Turbopack HARD-FATALS on a package named
  // in both lists; production chunking is the only venue the externalization was
  // ever for.
  serverExternalPackages: [
    "esbuild",
    "@electric-sql/pglite",
    ...(process.env.NODE_ENV === "development" ? [] : ["@vendoai/vendo"]),
  ],
  // Dev-only: resolve the whole @vendoai workspace graph to its TypeScript
  // source so edits anywhere in packages/*/src hot-reload here instead of
  // waiting on a `pnpm build`. Turbopack matches the request verbatim, so
  // every entry point in every package's exports map needs its own line — and
  // their NodeNext `.js` specifiers only resolve to `.ts` because this app's
  // tsconfig is NodeNext too. Whole graph or nothing, deliberately: aliasing
  // only part of it leaves one bundle holding a src copy and a dist copy of
  // the same module, and state keyed by module identity (harnesses' WeakMap of
  // adapter slots, store's of internals) then splits silently across the two.
  // An externalized package must not stay aliased here: Turbopack HARD-FATALS on
  // a package named in BOTH transpilePackages and serverExternalPackages, which
  // is exactly why @vendoai/vendo's entry above is dev-conditional. `next build`
  // skips this block entirely and resolves dist/ like a published install would.
  ...(process.env.NODE_ENV === "development"
    ? {
        transpilePackages: ["@vendoai/core", "@vendoai/ui", "@vendoai/vendo"],
        turbopack: {
          resolveAlias: {
            "@vendoai/core": "../../packages/core/src/index.ts",
            "@vendoai/core/conformance": "../../packages/core/src/conformance/index.ts",
            "@vendoai/core/apps": "../../packages/core/src/apps/index.ts",
            "@vendoai/ui": "../../packages/ui/src/index.ts",
            "@vendoai/ui/chrome": "../../packages/ui/src/chrome/index.ts",
            "@vendoai/ui/tree": "../../packages/ui/src/tree/index.ts",
            "@vendoai/ui/kit": "../../packages/ui/src/kit/index.ts",
            "@vendoai/vendo": "../../packages/vendo/src/index.ts",
            "@vendoai/vendo/server": "../../packages/vendo/src/server.ts",
            "@vendoai/vendo/apps": "../../packages/vendo/src/apps/index.ts",
            "@vendoai/vendo/apps/testing": "../../packages/vendo/src/apps/testing/index.ts",
            "@vendoai/vendo/sandbox/e2b": "../../packages/vendo/src/sandbox/escalation/e2b/index.ts",
            "@vendoai/vendo/sandbox/edge": "../../packages/vendo/src/sandbox/edge/index.ts",
            "@vendoai/vendo/store": "../../packages/vendo/src/store/index.ts",
            "@vendoai/vendo/store/postgres": "../../packages/vendo/src/store/postgres.ts",
            "@vendoai/vendo/store/test-util": "../../packages/vendo/src/store/fake-console.ts",
            "@vendoai/vendo/actions": "../../packages/vendo/src/actions/index.ts",
            "@vendoai/vendo/actions/presets": "../../packages/vendo/src/actions/presets/index.ts",
            "@vendoai/vendo/actions/presets/auth-js": "../../packages/vendo/src/actions/presets/auth-js.ts",
            "@vendoai/vendo/actions/sync": "../../packages/vendo/src/actions/sync/public.ts",
            "@vendoai/vendo/telemetry": "../../packages/vendo/src/telemetry/index.ts",
            "@vendoai/vendo/guard": "../../packages/vendo/src/guard/index.ts",
            "@vendoai/vendo/harnesses": "../../packages/vendo/src/harnesses/index.ts",
            "@vendoai/vendo/harnesses/vendo": "../../packages/vendo/src/harnesses/vendo/index.ts",
            "@vendoai/vendo/harnesses/claude-code": "../../packages/vendo/src/harnesses/claude-code/index.ts",
            "@vendoai/vendo/harnesses/claude-turn": "../../packages/vendo/src/harnesses/claude-code/claude-turn.ts",
            // No line for @vendoai/vendo/box-door: it ships as source
            // (box/turn-routes.mjs), so there is no dist copy to bypass.
            "@vendoai/vendo/extract": "../../packages/vendo/src/cli/extract/index.ts",
            "@vendoai/vendo/react": "../../packages/vendo/src/react.tsx",
            "@vendoai/vendo/ai-sdk": "../../packages/vendo/src/ai-sdk.ts",
            "@vendoai/vendo/mastra": "../../packages/vendo/src/mastra.ts",
            "@vendoai/vendo/auth/auth0": "../../packages/vendo/src/auth-presets/auth0.ts",
            "@vendoai/vendo/auth/auth-js": "../../packages/vendo/src/auth-presets/auth-js.ts",
            "@vendoai/vendo/auth/clerk": "../../packages/vendo/src/auth-presets/clerk.ts",
            "@vendoai/vendo/auth/jwt": "../../packages/vendo/src/auth-presets/jwt.ts",
            "@vendoai/vendo/auth/supabase": "../../packages/vendo/src/auth-presets/supabase.ts",
          },
        },
      }
    : { transpilePackages: ["@vendoai/ui"] }),
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
