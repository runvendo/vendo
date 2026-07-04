import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toNodeHandler, type FetchHandler } from "./node";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    // An aborted client leaves its socket half-torn-down from the server's
    // perspective; force it shut so this cleanup doesn't ride out Node's
    // keep-alive timers between tests.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** Boots a real node:http server wrapping the bridge around `handler`. */
async function startServer(handler: FetchHandler): Promise<string> {
  server = createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://localhost:${port}`;
}

describe("toNodeHandler", () => {
  it("translates method, full URL (incl. query string), headers, and JSON body into the Request", async () => {
    let captured!: Request;
    let capturedBody: unknown;
    const url = await startServer(async (req) => {
      captured = req;
      capturedBody = await req.json();
      return new Response(null, { status: 204 });
    });

    await fetch(`${url}/foo/bar?a=1&b=two`, {
      method: "POST",
      headers: { "x-test": "hello", "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(captured.method).toBe("POST");
    const parsed = new URL(captured.url);
    expect(parsed.pathname).toBe("/foo/bar");
    expect(parsed.search).toBe("?a=1&b=two");
    expect(captured.headers.get("x-test")).toBe("hello");
    expect(captured.headers.get("content-type")).toBe("application/json");
    expect(capturedBody).toEqual({ hello: "world" });
  });

  it("produces a Request with no body for a GET request", async () => {
    let captured!: Request;
    const url = await startServer(async (req) => {
      captured = req;
      return new Response("ok");
    });

    await fetch(url);

    expect(captured.method).toBe("GET");
    expect(captured.body).toBeNull();
  });

  it("translates a JSON Response back: status, headers, and body", async () => {
    const url = await startServer(async () =>
      Response.json({ ok: true }, { status: 201, headers: { "x-extra": "1" } }),
    );

    const res = await fetch(url);

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("x-extra")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through multiple set-cookie headers", async () => {
    const url = await startServer(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("ok", { headers });
    });

    const res = await fetch(url);

    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("streams a ReadableStream response incrementally, not buffered", async () => {
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const url = await startServer(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-A"));
          await gate;
          controller.enqueue(new TextEncoder().encode("chunk-B"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });

    const res = await fetch(url);
    const reader = res.body!.getReader();

    // If the bridge buffered the whole stream before writing, this read
    // would never resolve since chunk-B (and the stream close) is gated
    // behind `releaseB`, which we haven't called yet.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("chunk-A");

    releaseB();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("chunk-B");
    const third = await reader.read();
    expect(third.done).toBe(true);
  });

  it("cancels the response stream when the client disconnects mid-stream", async () => {
    let cancelled = false;
    const url = await startServer(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-A"));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream);
    });

    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    // Read the first chunk to make sure the stream actually started before
    // disconnecting, then abort mid-stream (the server never closes it).
    await res.body!.getReader().read();
    controller.abort();

    await vi.waitFor(
      () => {
        expect(cancelled).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("returns 500 without hanging when the handler throws", async () => {
    const url = await startServer(async () => {
      throw new Error("boom");
    });

    const res = await fetch(url);

    expect(res.status).toBe(500);
    await expect(res.text()).resolves.toBeTypeOf("string");
  });
});
