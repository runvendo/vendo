import { devPortFrom } from "@vendoai/core";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { RUNTIME_TOKEN, injectRuntimeConfig, readRuntimeConfig } from "./provision.mjs";

/**
 * The dev server's port — DECLARED by the host at box create, never discovered.
 * Track D's live preview reaches it at `SandboxMachine.url(devPort)`, and that
 * URL is minted before the dev server has necessarily booted, so this side and
 * the host side read the SAME constant from `@vendoai/core` (`VENDO_DEV_PORT`,
 * carried in `VENDO_DEV_PORT_ENV`). A second literal here is how the two drift.
 *
 * Three ports exist in a box and no more: `$PORT` (8080) is the served app,
 * 8811 is the harness control port, this is the dev server.
 */
const devPort = devPortFrom(process.env);

/** The dev server is a server too, so it owes the page the same provision data
 *  `server.js` splices in — otherwise the live preview is the one surface that
 *  renders unbranded and without an app identity. ONE reader, two callers. */
const provisionData = (): Plugin => ({
  name: "vendo-provision-data",
  apply: "serve",
  transformIndexHtml: {
    order: "post",
    handler: (html) => injectRuntimeConfig(html, readRuntimeConfig(process.cwd())),
  },
});

export default defineConfig({
  plugins: [react(), provisionData()],
  // RELATIVE, and load-bearing. A shared app is served through the wire proxy,
  // which mounts it under `/apps/<id>/serve/` (packages/vendo/src/wire/box.ts,
  // servedProxyRoutes): an absolute `/assets/...` URL leaves that mount and 404s
  // on the host origin. Every asset URL must resolve against the page.
  base: "./",
  server: {
    port: devPort,
    // Fail loudly rather than drift to 5174 — Track D's preview URL is built
    // from this number, and a silently-moved dev server is an invisible 404.
    strictPort: true,
    // The box's ingress reaches the dev server from OUTSIDE, so bind every
    // interface, and accept the provider's hostname: Vite refuses an unknown
    // Host header by default ("Blocked request. This host is not allowed."),
    // and the provider's host is minted per wake, so it cannot be enumerated.
    host: true,
    allowedHosts: true,
  },
  build: { outDir: "dist", emptyOutDir: true },
});
