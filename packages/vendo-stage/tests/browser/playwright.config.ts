import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: dir,
  testMatch: "*.spec.ts",
  webServer: {
    command: `vite --config ${dir}/vite.config.ts`,
    port: 5183,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5183",
  },
});
