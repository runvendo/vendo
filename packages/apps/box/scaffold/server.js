/**
 * Vendo served-app scaffold (layer 3) — the warm start the in-box agent
 * copies into /app and EDITS. Zero-dependency Node: the skin contract's
 * plumbing (POST /fn/<name> envelopes, GET /vendo.json, the served entry
 * page) is already wired; add fn handlers in fns.js and build the page in
 * index.html.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fns } from "./fns.js";

const PORT = Number(process.env.PORT ?? 8080);
const FN_NAME = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]{0,63})$/;

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // Skin contract: the manifest, verbatim.
    if (req.method === "GET" && url.pathname === "/vendo.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(new URL("./vendo.json", import.meta.url)));
      return;
    }

    // Skin contract: POST /fn/<name> → {result} on success, {error} otherwise.
    const fn = req.method === "POST" ? FN_NAME.exec(url.pathname) : null;
    if (fn !== null) {
      const handler = fns[fn[1]];
      if (handler === undefined) {
        json(res, 404, { error: { code: "not-found", message: `no fn ${fn[1]}` } });
        return;
      }
      let args = {};
      try {
        args = JSON.parse(await readBody(req) || "{}").args ?? {};
      } catch {
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

    // The served surface: GET / is the entry page (add more routes as needed).
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(new URL("./index.html", import.meta.url)));
      return;
    }

    json(res, 404, { error: { code: "not-found", message: `no route ${req.method} ${url.pathname}` } });
  } catch (error) {
    json(res, 500, { error: { code: "machine", message: error instanceof Error ? error.message : "server error" } });
  }
});

server.listen(PORT, () => console.log(`[app] listening on ${PORT}`));
