import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "@vendoai/telemetry": fileURLToPath(new URL("../vendo-telemetry/src/index.ts", import.meta.url)),
    },
  },
});
