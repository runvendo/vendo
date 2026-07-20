import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Standalone build for the W2 Kit gallery (browser verification only). */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
  esbuild: { jsx: "automatic" },
  server: { port: 5178 },
  preview: { port: 5178 },
});
