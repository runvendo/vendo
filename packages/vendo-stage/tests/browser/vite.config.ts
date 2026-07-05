import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Root is this harness directory so fixtures/ and public/ resolve correctly.
const harnessDir = r(".");

export default defineConfig({
  root: harnessDir,
  plugins: [react()],
  resolve: {
    alias: {
      // Point @vendoai/stage to the package source (not the built dist).
      "@vendoai/stage": r("../../src/index.ts"),
      // Point @vendoai/core to the monorepo source.
      "@vendoai/core": r("../../../vendo-core/src/index.ts"),
    },
  },
  server: { port: 5183 },
});
