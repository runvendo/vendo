import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { createWireServer } from "../../test/wire-server.ts";

const harnessRoot = fileURLToPath(new URL(".", import.meta.url));

/** 08-ui §4–5 — real-browser harness backed by the exact in-test wire route table.
 *
 * Served PRODUCTION-BUILT by default (`vite build` + `vite preview`). Vite's dev
 * server hands the app `process.env.NODE_ENV === "development"`, which turns on
 * every `developmentMode()` rail in the chrome — the dev-only detail lines that
 * §16 forbids a person from ever reading. A browser suite that only ever ran on
 * the dev server was therefore asserting, and photographing, copy that ships to
 * nobody: `verification-eng229.spec.ts` pinned a raw driver sentence that a real
 * user never sees. `VENDO_HARNESS_DEV=1` puts the dev server back for debugging.
 */
export default defineConfig(async ({ command }) => {
  // `vite build` must not leave a wire server listening; only a served run needs one.
  const wire = command === "build" ? null : await createWireServer({ islandApp: true });
  if (wire !== null) {
    wire.state.posture = "rules";
    // §16 law 3 (/byo-embed-failed) — a terminally failed build carrying the
    // EXACT sentence the wave E2E photographed in a real user's thread on
    // 2026-08-03. It is a developer's sentence (a component name, an unevaluated
    // expression) and the embed must not print any of it. Harness-only: the unit
    // wire fixture seeds no failed apps, so nothing else sees this row.
    wire.state.failedApps.set("app_build_failed", {
      reason: "This app wasn't created, because it didn't pass the checks that keep an app honest:"
        + " the `value` expression is a declarative string that the DataTable does not evaluate,"
        + " not JavaScript: amount / sum(spending.data.amount)",
      retryable: true,
      prompt: "a board showing where my money goes each month",
    });
  }

  // Ephemeral by default so parallel lanes never collide; playwright.config
  // reserves a free port and passes it via env + the CLI --port flag.
  const port = Number(process.env.VENDO_HARNESS_PORT) || 4_173;
  const proxy = wire === null ? undefined : {
    "/api/vendo": {
      target: wire.url,
      changeOrigin: false,
      rewrite: (path: string) => path.replace(/^\/api\/vendo/, ""),
    },
  };
  const served = { host: "127.0.0.1", port, strictPort: true, ...(proxy === undefined ? {} : { proxy }) };

  return {
    root: harnessRoot,
    clearScreen: false,
    // The harness imports the package's source entry files directly (the same
    // entries the subpath exports point at): a self-import by package name is
    // not a layering edge the dependency guard can tell apart from a real one.
    server: served,
    // `vite preview` serves this, and it is what the browser suite runs against.
    preview: served,
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
    plugins: [{
      name: "vendo-wire-lifecycle",
      configureServer(server: ViteDevServer) {
        server.httpServer?.once("close", () => void wire?.close());
      },
      configurePreviewServer(server: { httpServer: { once(event: string, cb: () => void): void } }) {
        server.httpServer.once("close", () => void wire?.close());
      },
    }],
  };
});
