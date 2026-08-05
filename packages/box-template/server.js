/**
 * The box app's server — the skin contract, unchanged.
 *
 * Deliberately the same 90-odd lines of boring Node the zero-dependency scaffold
 * shipped: `POST /fn/<name>` envelopes, `GET /vendo.json` verbatim, and `GET /`
 * as the entry page. The ONE new job is serving Vite's build output, because the
 * page is now a real app instead of hand-rolled HTML. No framework, no router.
 *
 * The build is the AGENT's job (tsc + `vite build` are its code validators), so
 * this only builds when there is nothing to serve — which is exactly the cold
 * provision case: source files + this template and no snapshot must still come up.
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fns } from "./fns.js";
import { injectRuntimeConfig, readRuntimeConfig } from "./provision.mjs";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(APP_ROOT, "dist");
const ENTRY = path.join(DIST, "index.html");
const PORT = Number(process.env.PORT ?? 8080);
const FN_NAME = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]{0,63})$/;
const BODY_MAX_BYTES = 1024 * 1024;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

// A cold provision has source but no build output. Build once, here, rather than
// teaching the supervisor about builds: `.vendo/run` stays the single line it
// has always been, and a box restored from files alone still serves.
if (!existsSync(ENTRY)) {
  spawnSync("npm", ["run", "build"], { cwd: APP_ROOT, stdio: "inherit" });
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

/** Bounded read: one oversized request must not exhaust the app's memory. */
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > BODY_MAX_BYTES) {
      reject(Object.assign(new Error("body too large"), { tooLarge: true }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

/** A built asset's absolute path, or null if the request left `dist/`. Decoded
 *  first: an escaped `%2e%2e%2f` is the traversal a raw pathname check misses. */
const assetPath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(DIST, `.${decoded}`);
  return resolved === DIST || resolved.startsWith(DIST + path.sep) ? resolved : null;
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // Skin contract: the manifest, verbatim.
    if (req.method === "GET" && url.pathname === "/vendo.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(path.join(APP_ROOT, "vendo.json")));
      return;
    }

    // Skin contract: POST /fn/<name> → {result} on success, {error} otherwise.
    const fn = req.method === "POST" ? FN_NAME.exec(url.pathname) : null;
    if (fn !== null) {
      // Own entries only: an inherited name like "toString" is not an fn.
      const handler = Object.prototype.hasOwnProperty.call(fns, fn[1]) && typeof fns[fn[1]] === "function"
        ? fns[fn[1]]
        : undefined;
      if (handler === undefined) {
        json(res, 404, { error: { code: "not-found", message: `no fn ${fn[1]}` } });
        return;
      }
      let args = {};
      try {
        args = JSON.parse(await readBody(req) || "{}").args ?? {};
      } catch (error) {
        if (error !== null && typeof error === "object" && error.tooLarge === true) {
          json(res, 413, { error: { code: "validation", message: `body exceeds ${BODY_MAX_BYTES} bytes` } });
          return;
        }
        json(res, 400, { error: { code: "validation", message: "body must be JSON like {\"args\": {...}}" } });
        return;
      }
      try {
        json(res, 200, { result: await handler(args) });
      } catch (error) {
        json(res, 500, { error: { code: "machine", message: error instanceof Error ? error.message : "fn failed" } });
      }
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      // The served surface: GET / is the built entry page, with the provision
      // data spliced in so the app knows which app it is before its first paint.
      // HEAD answers too — the host's keepalive probes it.
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(req.method === "HEAD"
          ? undefined
          : injectRuntimeConfig(readFileSync(ENTRY, "utf8"), readRuntimeConfig(APP_ROOT)));
        return;
      }
      // Vite's build output: hashed filenames under assets/, plus whatever the
      // app put in public/. Read per request, never cached: the agent rebuilds
      // while this process runs, and a cached page would serve dead asset hashes.
      const file = assetPath(url.pathname);
      if (file !== null && existsSync(file)) {
        res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : readFileSync(file));
        return;
      }
    }

    json(res, 404, { error: { code: "not-found", message: `no route ${req.method} ${url.pathname}` } });
  } catch (error) {
    json(res, 500, { error: { code: "machine", message: error instanceof Error ? error.message : "server error" } });
  }
});

server.listen(PORT, () => console.log(`[app] listening on ${PORT}`));
