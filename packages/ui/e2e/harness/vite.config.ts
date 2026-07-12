import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { createWireServer } from "../../test/wire-server.ts";

const harnessRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/** 08-ui §4–5 — real-browser harness backed by the exact in-test wire route table. */
export default defineConfig(async () => {
  const wire = await createWireServer();
  wire.state.posture = "unconfigured";

  return {
    root: harnessRoot,
    clearScreen: false,
    resolve: {
      alias: [
        { find: /^@vendoai\/ui\/chrome$/, replacement: `${sourceRoot}chrome/index.ts` },
        { find: /^@vendoai\/ui\/tree$/, replacement: `${sourceRoot}tree/index.ts` },
        { find: /^@vendoai\/ui\/voice$/, replacement: `${sourceRoot}voice/index.ts` },
        { find: /^@vendoai\/ui$/, replacement: `${sourceRoot}index.ts` },
      ],
    },
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
