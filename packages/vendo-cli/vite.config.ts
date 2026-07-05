import { defineConfig } from "vite";
import { builtinModules } from "node:module";

/**
 * Bundles the CLI for plain-Node execution. @vendoai/* workspace code is
 * inlined (its dist ESM uses extensionless relative imports that bundlers
 * resolve but Node does not); real npm deps stay external and resolve from
 * the installed package's node_modules.
 *
 * INVARIANT: every external npm package the bundle ends up importing must be
 * declared in this package's `dependencies` — INCLUDING deps of the inlined
 * @vendoai/* code, whose imports land in dist/cli.js and resolve from
 * @vendoai/cli's own node_modules (pnpm's strict layout won't fall through to
 * a transitive dep). E.g. `@ai-sdk/anthropic` looks unused in src/ but is
 * statically imported by the inlined `@vendoai/server/model` — removing it
 * breaks the built CLI at startup. Check `grep 'from "' dist/cli.js` before
 * pruning "dead" deps.
 */
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export default defineConfig({
  build: {
    target: "node18",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    lib: { entry: "src/cli.ts", formats: ["es"], fileName: () => "cli.js" },
    rollupOptions: {
      external: (id) =>
        builtins.has(id) || (!id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@vendoai/")),
      output: { banner: "#!/usr/bin/env node" },
    },
  },
});
