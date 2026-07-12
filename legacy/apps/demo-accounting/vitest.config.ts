import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Force ONE React: @vendoai/components would otherwise resolve its own
      // React 18 while the app renders with React 19 (two-React error in jsdom).
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime"),
    },
  },
})
