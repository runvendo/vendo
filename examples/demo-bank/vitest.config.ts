import { defineConfig } from "vitest/config"
import { workerCaps } from "../../vitest.shared.js";
import path from "node:path"

export default defineConfig({
  test: { ...workerCaps, environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Force one React instance across the host and Vendo UI in jsdom.
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime"),
    },
  },
})
