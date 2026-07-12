import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Builds the Vendo React shim: one self-contained ESM file that re-exports
 * React, ReactDOM/client, and react/jsx-runtime.  The sandbox embeds this as
 * a blob: URL and registers it in an import map so all host bundles share it.
 */
export default defineConfig({
  root: harnessDir,
  define: {
    // React production build references process.env.NODE_ENV.
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    lib: {
      entry: "sample-bundle/react-shim.ts",
      formats: ["es"],
      fileName: () => "vendo-react-runtime.js",
    },
    outDir: "public",
    emptyOutDir: false,
  },
});
