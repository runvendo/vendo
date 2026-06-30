import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@flowlet/core": fileURLToPath(new URL("../packages/flowlet-core/src", import.meta.url)),
    },
  },
  server: { port: 5180 },
});
