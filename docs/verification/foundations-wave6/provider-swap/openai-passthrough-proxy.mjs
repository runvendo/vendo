#!/usr/bin/env node
/**
 * Wave 6b (ENG-239) — trivial OpenAI-compatible pass-through proxy.
 *
 * Forwards every request verbatim to https://api.openai.com and streams the
 * response back, logging one line per request (method, path, model, status).
 * This is the "OpenAI-compatible proxy" leg of the provider-swap beat: the
 * host talks to http://127.0.0.1:<port>/v1 via @ai-sdk/openai-compatible and
 * the proxy log proves the traffic went through it.
 *
 * Usage:
 *   OPENAI_API_KEY=... node openai-passthrough-proxy.mjs [port]
 *
 * The upstream key is injected server-side so the host-side key can be a
 * dummy value — same shape as a corporate LLM gateway.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8787);
const upstream = "https://api.openai.com";
const upstreamKey = process.env.OPENAI_API_KEY;
if (!upstreamKey) {
  console.error("OPENAI_API_KEY is required (injected upstream, never logged)");
  process.exit(1);
}

let n = 0;
const server = http.createServer(async (req, res) => {
  const id = ++n;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let model = "-";
  try {
    model = JSON.parse(body.toString("utf8")).model ?? "-";
  } catch {
    /* non-JSON body (e.g. GET) */
  }
  const headers = { ...req.headers, authorization: `Bearer ${upstreamKey}` };
  delete headers.host;
  delete headers["content-length"];
  try {
    const response = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      duplex: "half",
    });
    console.log(
      `[proxy] #${id} ${new Date().toISOString()} ${req.method} ${req.url} model=${model} -> ${response.status}`,
    );
    // fetch() already decompressed the body, so the upstream content-encoding/
    // content-length headers no longer describe the bytes we forward. (Multiple
    // set-cookie headers would also collapse here, but the OpenAI API sets none.)
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    res.writeHead(response.status, responseHeaders);
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error(`[proxy] #${id} ${req.method} ${req.url} FAILED: ${error?.message ?? error}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream fetch failed" } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[proxy] OpenAI pass-through listening on http://127.0.0.1:${port} -> ${upstream}`);
});
