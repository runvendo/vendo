import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "runs/**"],
    passWithNoTests: true,
    server: {
      deps: {
        // These SDKs import their own .css from JS; inline them so vite
        // transforms the css instead of node choking on the extension.
        inline: [/@thesysai\/genui-sdk/, /@crayonai\//, /@openuidev\//],
      },
    },
  },
  resolve: {
    alias: {
      // Force one React instance across the cockpit and Vendo UI in jsdom.
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime"),
    },
  },
})
