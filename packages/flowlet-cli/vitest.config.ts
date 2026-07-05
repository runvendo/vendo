import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "@flowlet/telemetry": fileURLToPath(new URL("../flowlet-telemetry/src/index.ts", import.meta.url)),
    },
  },
});
