/**
 * A `node:http` request/response pair, handed to a Web `Request` → `Response`
 * handler and written back verbatim.
 *
 * Not a double: this is the same adapter a Node host writes for real, so a
 * fixture that serves the umbrella's own `handler` over a loopback socket is
 * exercising the real handler over real HTTP. Suites that need the WIRE rather
 * than an in-process call use it to get one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export async function nodeBridge(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const host = req.headers.host ?? "127.0.0.1";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://${host}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? error.message : "node bridge failed");
  }
}
