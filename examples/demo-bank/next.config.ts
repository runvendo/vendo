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
  // Dev-only: resolve the whole @vendoai workspace graph to its TypeScript
  // source so edits anywhere in packages/*/src hot-reload here instead of
  // waiting on a `pnpm build`. Turbopack matches the request verbatim, so
  // every entry point in every package's exports map needs its own line — and
  // their NodeNext `.js` specifiers only resolve to `.ts` because this app's
  // tsconfig is NodeNext too. Whole graph or nothing, deliberately: aliasing
  // only part of it leaves one bundle holding a src copy and a dist copy of
  // the same module, and state keyed by module identity (harnesses' WeakMap of
  // adapter slots, store's of internals) then splits silently across the two.
  // @vendoai/store is the lone holdout — it is externalized for PGlite above,
  // and node cannot require .ts. `next build` skips the block entirely and
  // resolves dist/ like a published install would.
  ...(process.env.NODE_ENV === "development"
    ? {
        transpilePackages: [
          "@vendoai/actions",
          "@vendoai/agents",
          "@vendoai/apps",
          "@vendoai/automations",
          "@vendoai/core",
          "@vendoai/guard",
          "@vendoai/harnesses",
          "@vendoai/knowledge",
          "@vendoai/mcp",
          "@vendoai/telemetry",
          "@vendoai/ui",
          "@vendoai/vendo",
        ],
        turbopack: {
          resolveAlias: {
            "@vendoai/actions": "../../packages/actions/src/index.ts",
            "@vendoai/actions/presets": "../../packages/actions/src/presets/index.ts",
            "@vendoai/actions/presets/auth-js": "../../packages/actions/src/presets/auth-js.ts",
            "@vendoai/actions/sync": "../../packages/actions/src/sync/public.ts",
            "@vendoai/agents": "../../packages/agents/src/index.ts",
            "@vendoai/apps": "../../packages/apps/src/server/index.ts",
            "@vendoai/apps/contract": "../../packages/apps/src/contract/index.ts",
            "@vendoai/apps/e2b": "../../packages/apps/src/server/escalation/e2b/index.ts",
            "@vendoai/apps/testing": "../../packages/apps/src/server/testing/index.ts",
            "@vendoai/automations": "../../packages/automations/src/index.ts",
            "@vendoai/core": "../../packages/core/src/index.ts",
            "@vendoai/core/conformance": "../../packages/core/src/conformance/index.ts",
            "@vendoai/guard": "../../packages/guard/src/index.ts",
            "@vendoai/harnesses": "../../packages/harnesses/src/index.ts",
            "@vendoai/harnesses/vendo": "../../packages/harnesses/src/vendo/index.ts",
            "@vendoai/harnesses/claude-code": "../../packages/harnesses/src/claude-code/index.ts",
            "@vendoai/harnesses/claude-turn": "../../packages/harnesses/src/claude-code/claude-turn.ts",
            // No line for @vendoai/harnesses/box-door: it ships as source
            // (box/turn-routes.mjs), so there is no dist copy to bypass.
            "@vendoai/knowledge": "../../packages/knowledge/src/index.ts",
            "@vendoai/mcp": "../../packages/mcp/src/index.ts",
            "@vendoai/telemetry": "../../packages/vendo-telemetry/src/index.ts",
            "@vendoai/ui": "../../packages/ui/src/index.ts",
            "@vendoai/ui/chrome": "../../packages/ui/src/chrome/index.ts",
            "@vendoai/ui/tree": "../../packages/ui/src/tree/index.ts",
            "@vendoai/ui/kit": "../../packages/ui/src/kit/index.ts",
            "@vendoai/vendo": "../../packages/vendo/src/index.ts",
            "@vendoai/vendo/server": "../../packages/vendo/src/server.ts",
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
