import { VendoError, type AppDocument } from "@vendoai/core";
import { FETCH_SHIM_BOOT_PRELUDE, FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "./fetch-shim.js";
import { TREE_RENDERER_SOURCE } from "./tree-renderer.gen.js";

export interface ServedAppScaffoldFile {
  path: string;
  content: string;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vendo app</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: var(--vendo-color-background, #fff); color: var(--vendo-color-text, #1a1a1e); }
    #vendo-served-tree { min-width: 0; }
  </style>
</head>
<body>
  <main id="vendo-served-tree" aria-live="polite"></main>
  <script src="/tree-renderer.js"></script>
</body>
</html>`;

const SERVER_SOURCE = `const http = require("node:http");
const fs = require("node:fs");

const files = {
  "/": ["/app/index.html", "text/html; charset=utf-8"],
  "/index.html": ["/app/index.html", "text/html; charset=utf-8"],
  "/tree.json": ["/app/tree.json", "application/json; charset=utf-8"],
  "/components.json": ["/app/components.json", "application/json; charset=utf-8"],
  "/tree-renderer.js": ["/app/tree-renderer.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer((request, response) => {
  const path = new URL(request.url || "/", "http://localhost").pathname;
  const asset = request.method === "GET" || request.method === "HEAD" ? files[path] : undefined;
  if (!asset) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "route not found" } }));
    return;
  }
  response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(asset[0]).pipe(response);
});

const port = Number.parseInt(process.env.PORT || "8080", 10);
server.listen(port, "0.0.0.0");
`;

/** 06-apps §2 — self-contained first served version for an invisible tree→http graduation. */
export const servedAppScaffold = (app: AppDocument): ServedAppScaffoldFile[] => {
  if (app.tree === undefined) {
    throw new VendoError("validation", "rung-4 graduation requires a kept tree");
  }
  // Keep every runtime-owned file in this one ordered list. A later scaffold wave can
  // add preload/runtime support here without changing the graduation machinery.
  return [
    { path: "/app/tree.json", content: JSON.stringify(app.tree) },
    { path: "/app/components.json", content: JSON.stringify(app.components ?? {}) },
    { path: "/app/tree-renderer.js", content: TREE_RENDERER_SOURCE },
    { path: "/app/index.html", content: INDEX_HTML },
    { path: "/app/.vendo/scaffold-server.cjs", content: SERVER_SOURCE },
    // ENG-290 M4 — the egress fetch shim rides in the scaffold so a rung-4
    // app's server code fetches external hosts through the §4.5 proxy route.
    { path: FETCH_SHIM_PATH, content: FETCH_SHIM_SOURCE },
    {
      path: "/app/start.sh",
      content: `#!/bin/sh\n${FETCH_SHIM_BOOT_PRELUDE}\nexec node /app/.vendo/scaffold-server.cjs\n`,
    },
  ];
};
