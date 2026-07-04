/**
 * `toNodeHandler()` bridges a fetch-native handler — `(Request) => Promise<Response>`,
 * the shape `createFlowletFetchHandler()` returns — onto Node's
 * `(IncomingMessage, ServerResponse)` listener shape. This is what makes
 * mounting Flowlet on Express a one-liner and plain `node:http` trivial.
 *
 * Plain node:http:
 *   import { createServer } from "node:http";
 *   createServer(toNodeHandler(createFlowletFetchHandler())).listen(3000);
 *
 * Express (also works as `app.use(...)` middleware since Express calls
 * handlers with the same `(req, res)` shape):
 *   app.all("/api/flowlet/*", toNodeHandler(createFlowletFetchHandler()));
 *
 * Streaming-safe: the Response body is piped to `res` chunk-by-chunk (no
 * buffering), so SSE and other chunked responses arrive incrementally. A
 * client disconnect aborts the Request's `signal` and cancels the response
 * body's stream; a thrown/rejected handler becomes a 500 instead of hanging
 * the socket. This file only converts protocols — it knows nothing about
 * Flowlet's routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export type FetchHandler = (req: Request) => Promise<Response>;
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function toNodeHandler(handler: FetchHandler): NodeHandler {
  return async function nodeHandler(req, res) {
    const controller = new AbortController();
    // "close" fires both on a normal completed exchange and on a premature
    // client disconnect; aborting after a normal completion is a no-op, so
    // one listener covers both without extra bookkeeping.
    req.on("close", () => controller.abort());

    let response: Response;
    try {
      response = await handler(toWebRequest(req, controller.signal));
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    await writeNodeResponse(response, res, controller.signal);
  };
}

/** Builds the fetch `Request` node's incoming request describes. */
function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const scheme = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${scheme}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }

  return new Request(url, {
    method,
    headers,
    signal,
    // `duplex: "half"` is required by undici whenever the body is a stream.
    ...(hasBody
      ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" }
      : {}),
  } as RequestInit & { duplex?: "half" });
}

/** Writes a fetch `Response` back through `res`, streaming the body. */
async function writeNodeResponse(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  // `Headers` folds repeated `set-cookie` entries into one comma-joined
  // value on iteration, which is invalid for cookies; `getSetCookie()`
  // preserves them individually.
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) res.setHeader("set-cookie", setCookie);

  if (!response.body) {
    res.end();
    return;
  }
  if (signal.aborted) {
    await response.body.cancel().catch(() => {});
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  const onAbort = () => body.destroy();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await pipeline(body, res);
  } catch (err) {
    // A client disconnect destroys `body` mid-pipe, which surfaces here as
    // a rejected pipeline; the socket is already gone, so swallow it. Any
    // other failure is unexpected — surface it without crashing the server.
    if (!signal.aborted) console.error("[flowlet] toNodeHandler: response streaming failed:", err);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
