import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { startAgentBackend } from "./agent-backend.ts";
import { startBackends } from "./backends.ts";

const harnessRoot = fileURLToPath(new URL(".", import.meta.url));

/** J7 real-browser harness — the page runs against the REAL composed umbrella
 *  wire and the booted fixture host app (both started in-process here). */
export default defineConfig(async () => {
  const backends = await startBackends();
  // The standalone agent leg is its OWN mount on its own listener: it composes
  // `agent()` directly, with no umbrella and no host app in the picture, which
  // is exactly the deployment `agentHandler()` exists for.
  const standalone = await startAgentBackend();

  return {
    root: harnessRoot,
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      // Ephemeral by default so parallel lanes never collide; playwright.config
      // reserves a free port and passes it via env + the CLI --port flag.
      port: Number(process.env.VENDO_HARNESS_PORT) || 4_273,
      strictPort: true,
      proxy: {
        // No rewrite: the umbrella handler self-routes on the FULL /api/vendo/…
        // path, so the mount prefix must survive to the wire.
        "/api/vendo": { target: backends.wireUrl, changeOrigin: false },
        "/__test": { target: backends.wireUrl, changeOrigin: false },
        // Same rule: `agentHandler` self-routes on the FULL path, so the mount
        // prefix must survive to it.
        "/api/agent": { target: standalone.url, changeOrigin: false },
        "/__agent": { target: standalone.url, changeOrigin: false },
      },
    },
    plugins: [{
      name: "vendo-backends-lifecycle",
      configureServer(server: ViteDevServer) {
        server.httpServer?.once("close", () => void Promise.all([backends.close(), standalone.close()]));
      },
    }],
  };
});
