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
      // Point @flowlet/stage to the package source (not the built dist).
      "@flowlet/stage": r("../../src/index.ts"),
      // Point @flowlet/core to the monorepo source.
      "@flowlet/core": r("../../../flowlet-core/src/index.ts"),
    },
  },
  server: { port: 5183 },
});
