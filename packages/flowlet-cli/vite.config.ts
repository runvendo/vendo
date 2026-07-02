import { defineConfig } from "vite";
import { builtinModules } from "node:module";

/**
 * Bundles the CLI for plain-Node execution. @flowlet/* workspace code is
 * inlined (its dist ESM uses extensionless relative imports that bundlers
 * resolve but Node does not); real npm deps stay external and resolve from
 * the installed package's node_modules.
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
        builtins.has(id) || (!id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@flowlet/")),
      output: { banner: "#!/usr/bin/env node" },
    },
  },
});
