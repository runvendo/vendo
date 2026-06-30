import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Builds the externalized host bundle: same components as the self-contained
 * bundle but with "react", "react-dom", "react-dom/client", and
 * "react/jsx-runtime" left as external imports.  Inside the sandbox these
 * resolve to the Flowlet React shim via the import map.
 */
export default defineConfig({
  root: harnessDir,
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    lib: {
      entry: "sample-bundle/entry-ext.tsx",
      formats: ["es"],
      fileName: () => "host-bundle-ext.js",
    },
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
  },
});
