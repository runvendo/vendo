import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { createWireServer } from "../test/wire-server.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Lane D capture rig: the real chrome against the package's wire fixture. */
export default defineConfig(async () => {
  const wire = await createWireServer();
  wire.state.posture = "rules";
  return {
    root,
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: Number(process.env.VENDO_HARNESS_PORT) || 4_274,
      strictPort: true,
      proxy: {
        "/api/vendo": {
          target: wire.url,
          changeOrigin: false,
          rewrite: (path: string) => path.replace(/^\/api\/vendo/, ""),
        },
      },
    },
    plugins: [{
      name: "vendo-wire-lifecycle",
      configureServer(server: ViteDevServer) {
        server.httpServer?.once("close", () => void wire.close());
      },
    }],
  };
});
