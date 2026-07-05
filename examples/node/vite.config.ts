import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3301,
    // The Flowlet API lives on the plain node:http server (server.mjs).
    proxy: { "/api/flowlet": "http://localhost:3300" },
  },
});
