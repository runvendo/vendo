import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Root is this harness directory so relative paths in build config work correctly.
const harnessDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: harnessDir,
  plugins: [react()],
  define: {
    // React requires process.env.NODE_ENV — the sandboxed iframe has no `process` global.
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    lib: {
      entry: "sample-bundle/entry.tsx",
      formats: ["es"],
      fileName: () => "host-bundle.js",
    },
    outDir: "public",
    emptyOutDir: false,
    // Do NOT externalize react/react-dom — bundle them in (single React in the sandbox).
  },
});
