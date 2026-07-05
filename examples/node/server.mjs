/**
 * Flowlet on plain `node:http` — no Next.js, no framework.
 *
 * Two responsibilities Next handled implicitly:
 *   1. Mount the fetch-native handler under /api/flowlet/ (chat, action,
 *      integrations, capabilities, tick) via the toNodeHandler bridge.
 *   2. Statically serve the sandbox runtime assets from public/flowlet/
 *      (Next served them from the app's public dir; scripts/
 *      copy-flowlet-sandbox.mjs puts them there).
 *
 * Zero-config: ANTHROPIC_API_KEY (or any provider key, see FLOWLET_MODEL)
 * in the environment is all it needs. Run: `pnpm dev` (starts this + Vite).
 *
 * Monorepo caveat: the workspace dists are emitted for bundlers (extensionless
 * relative imports), so `dev:api` runs this file through `tsx`, whose resolver
 * handles them — same as apps/gmail's Express server. The code itself is plain
 * node:http; `node server.mjs` works once the packages ship Node-loadable ESM.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFlowletFetchHandler, toNodeHandler } from "@flowlet/server";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT ?? 3300);

const flowlet = toNodeHandler(createFlowletFetchHandler());

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/api/flowlet" || pathname.startsWith("/api/flowlet/")) {
    return flowlet(req, res);
  }

  // Sandbox runtime assets (react-runtime.js + components-sandbox.js).
  const file = path.normalize(path.join(publicDir, pathname));
  if (pathname.startsWith("/flowlet/") && file.startsWith(publicDir + path.sep)) {
    try {
      if ((await stat(file)).isFile()) {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        createReadStream(file).pipe(res);
        return;
      }
    } catch {
      /* fall through to 404 */
    }
  }

  res.statusCode = 404;
  res.end("not found — the web client is the Vite dev server (default http://localhost:3301)");
});

server.listen(PORT, () => {
  console.log(`[flowlet] API on http://localhost:${PORT}/api/flowlet`);
});
