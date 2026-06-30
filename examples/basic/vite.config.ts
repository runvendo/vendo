import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Stub out Node.js-only Composio packages for the browser build.
      // The example never provides a composio config, so these code paths
      // are never reached at runtime — the alias just satisfies the import graph.
      {
        find: "@composio/core",
        replacement: path.resolve(__dirname, "src/_stubs/node-only.ts"),
      },
      {
        find: "@composio/vercel",
        replacement: path.resolve(__dirname, "src/_stubs/node-only.ts"),
      },
    ],
  },
});
