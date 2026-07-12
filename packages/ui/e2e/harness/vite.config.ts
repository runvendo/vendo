import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { createWireServer } from "../../test/wire-server.ts";

const harnessRoot = fileURLToPath(new URL(".", import.meta.url));

/** 08-ui §4–5 — real-browser harness backed by the exact in-test wire route table. */
export default defineConfig(async () => {
  const wire = await createWireServer();
  wire.state.posture = "rules";

  return {
    root: harnessRoot,
    clearScreen: false,
    // The harness imports the package's source entry files directly (the same
    // entries the subpath exports point at): a self-import by package name is
    // not a layering edge the dependency guard can tell apart from a real one.
    server: {
      host: "127.0.0.1",
      port: 4_173,
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
