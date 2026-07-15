// ENG-286 local CONNECT proxy for the browser leg. Chromium is launched with
// --proxy-server=127.0.0.1:8888; CONNECT requests for *.mcp.vendo.run:443 are
// tunneled to the loopback broker TLS front (127.0.0.1:8444), and CONNECTs to
// 127.0.0.1 loopback ports pass straight through. Everything else is refused,
// so the proxy cannot be used to reach the outside world. Loopback only.
import http from "node:http";
import net from "node:net";

function target(hostname, port) {
  if (hostname.endsWith(".mcp.vendo.run") && port === 443) {
    return { host: "127.0.0.1", port: 8444 };
  }
  if ((hostname === "127.0.0.1" || hostname === "localhost")) {
    return { host: "127.0.0.1", port };
  }
  return null;
}

const server = http.createServer((req, res) => {
  // Absolute-form plain-HTTP proxy requests (the OAuth redirect_uri on
  // 127.0.0.1) forward to loopback targets only; everything else is refused.
  let url;
  try {
    url = new URL(req.url ?? "");
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  const destination = target(url.hostname, Number.parseInt(url.port || "80", 10));
  if (!destination || url.protocol !== "http:") {
    console.log(`[connect-proxy] REFUSED ${req.method} ${req.url}`);
    res.writeHead(403);
    res.end("loopback-only local proxy");
    return;
  }
  const upstream = http.request({
    host: destination.host,
    port: destination.port,
    method: req.method,
    path: url.pathname + url.search,
    headers: req.headers,
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
  console.log(`[connect-proxy] ${req.method} ${req.url} -> ${destination.host}:${destination.port}`);
});

server.on("connect", (req, clientSocket, head) => {
  const [hostname, portRaw] = (req.url ?? "").split(":");
  const port = Number.parseInt(portRaw ?? "443", 10);
  const destination = hostname === undefined ? null : target(hostname, port);
  if (!destination) {
    console.log(`[connect-proxy] REFUSED ${req.url}`);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = net.connect(destination.port, destination.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const drop = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", drop);
  clientSocket.on("error", drop);
  console.log(`[connect-proxy] ${req.url} -> ${destination.host}:${destination.port}`);
});

server.listen(8888, "127.0.0.1", () => console.log("[connect-proxy] listening on 127.0.0.1:8888"));
