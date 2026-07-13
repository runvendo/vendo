import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type ExpressRequest = IncomingMessage & { originalUrl?: string };
type RequestWithDuplex = RequestInit & { duplex?: "half" };

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Integrator-written adapter: Express/Node owns IncomingMessage and
 * ServerResponse while Vendo stays on the portable fetch contract.
 */
export async function serveFetchHandler(
  req: ExpressRequest,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    headers.append(req.rawHeaders[index]!, req.rawHeaders[index + 1]!);
  }

  const host = headers.get("host") ?? "127.0.0.1";
  const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";
  const init: RequestWithDuplex = { method, headers };
  if (BODY_METHODS.has(method.toUpperCase())) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  const response = await handler(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
  });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const fallbackCookie = response.headers.get("set-cookie");
  const cookies = typeof getSetCookie === "function"
    ? getSetCookie.call(response.headers)
    : fallbackCookie === null ? [] : [fallbackCookie];
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (response.body === null) {
    res.end();
    return;
  }

  // Pipeline preserves streaming backpressure; SSE chunks are never buffered.
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
}
