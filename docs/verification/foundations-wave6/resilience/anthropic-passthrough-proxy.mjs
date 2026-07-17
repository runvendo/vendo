#!/usr/bin/env node
/**
 * Wave 6b beat D (ENG-239) — logging pass-through proxy in front of
 * https://api.anthropic.com.
 *
 * The demo host points at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/v1
 * (no source change: `@ai-sdk/anthropic` reads that env var), so every provider
 * call the agent loop makes shows up here as one numbered request line plus a
 * matching "completed" line when the response finishes streaming.
 *
 * When the browser/client disconnects mid-turn, the wave-5 path (ENG-238) fires
 * the request AbortSignal through `agent.stream` into `streamText`, which tears
 * down the in-flight provider request. The proxy logs that teardown
 * ("CLIENT DISCONNECTED ... upstream canceled") and — the beat's evidence —
 * NO further provider request lines follow.
 *
 * Usage:  node anthropic-passthrough-proxy.mjs [port]   (default 8788)
 *
 * The host's own x-api-key header passes through untouched; the proxy never
 * logs headers or bodies.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8788);
const upstream = "https://api.anthropic.com";
const now = () => new Date().toISOString();

let n = 0;
const server = http.createServer(async (req, res) => {
  const id = ++n;
  const startedAt = Date.now();
  const controller = new AbortController();
  let settled = false; // response fully relayed OR teardown already logged

  // Fires when the HOST drops its connection to us mid-flight — i.e. the agent
  // loop aborted its provider call. Cancel the upstream request too.
  res.on("close", () => {
    if (settled || res.writableFinished) return;
    settled = true;
    controller.abort();
    console.log(
      `[provider-proxy] #${id} ${now()} CLIENT DISCONNECTED after ${Date.now() - startedAt}ms — in-flight provider call torn down by the host, upstream canceled`,
    );
  });

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  } catch {
    return; // client vanished while sending the request body; close handler logs
  }
  let model = "-";
  let stream = "-";
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    model = parsed.model ?? "-";
    stream = String(parsed.stream ?? false);
  } catch {
    /* non-JSON body (e.g. GET) */
  }
  console.log(
    `[provider-proxy] #${id} ${now()} ${req.method} ${req.url} model=${model} stream=${stream} — forwarding upstream`,
  );
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  try {
    const response = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      duplex: "half",
      signal: controller.signal,
    });
    console.log(`[provider-proxy] #${id} ${now()} upstream responded ${response.status}`);
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    res.writeHead(response.status, responseHeaders);
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
    if (!settled) {
      settled = true;
      console.log(
        `[provider-proxy] #${id} ${now()} completed in ${Date.now() - startedAt}ms`,
      );
    }
  } catch (error) {
    if (settled) return; // teardown already logged by the close handler
    settled = true;
    console.log(`[provider-proxy] #${id} ${now()} upstream error: ${error?.message ?? error}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[provider-proxy] ${now()} listening on http://127.0.0.1:${port} -> ${upstream}`);
});
