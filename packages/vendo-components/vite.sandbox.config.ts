import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));

/** Builds the sandbox host bundle: ESM, React EXTERNALIZED so the stage's
 *  import map supplies the shared shim instance. */
export default defineConfig({
  root: pkgDir,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    lib: {
      entry: "bundle/entry.ts",
      formats: ["es"],
      fileName: () => "vendo-components-sandbox.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
    outDir: "dist-sandbox",
    emptyOutDir: true,
  },
});
