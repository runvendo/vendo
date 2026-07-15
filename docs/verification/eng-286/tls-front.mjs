// ENG-286 local TLS fronting: two https listeners with a throwaway self-signed
// cert, streaming requests through to plain-http local services untouched.
//   127.0.0.1:8444 (SNI *.mcp.vendo.run) -> broker  http://127.0.0.1:4310
//   127.0.0.1:8443                        -> Maple   http://127.0.0.1:3000
// The browser reaches https://maple.mcp.vendo.run (port 443) through the
// loopback CONNECT proxy (connect-proxy.mjs), which remaps that host:port to
// 127.0.0.1:8444 — nothing binds a privileged port, nothing leaves loopback.
// Host headers are preserved so the broker's tenant routing and Maple's
// request handling see the public names. Local throwaway; never deployed.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const tls = {
  key: readFileSync(new URL("./tls.key", import.meta.url)),
  cert: readFileSync(new URL("./tls.crt", import.meta.url)),
};

function front(listenPort, upstreamPort, label) {
  const server = https.createServer(tls, (req, res) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (error) => {
      console.error(`[${label}] upstream error:`, error.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    console.log(`[${label}] ${req.method} https://${req.headers.host}${req.url}`);
  });
  server.listen(listenPort, "127.0.0.1", () =>
    console.log(`[${label}] listening on 127.0.0.1:${listenPort} -> 127.0.0.1:${upstreamPort}`));
  server.on("error", (error) => {
    console.error(`[${label}] listen error:`, error.message);
    process.exit(1);
  });
}

front(8444, 4310, "broker-front");
front(8443, 3000, "maple-front");
