import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSE_KEEPALIVE_FRAME, withSseKeepalive } from "./sse-keepalive.js";

// Blueprint §4.1 item 5 / §4.2 — the SERVER→CLIENT half of the wire's
// keepalive. Distinct from `heartbeat.ts`, which is the CLIENT→SERVER abort
// beat: this one is transport framing, never an event.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function sourceResponse(headers: Record<string, string> = {}): {
  response: Response;
  push: (text: string) => void;
  end: () => void;
  fail: (error: Error) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { done, value } = await reader.read();
  if (done) return "<done>";
  return decoder.decode(value);
}

describe("withSseKeepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gets a first frame out before the source has produced anything", async () => {
    // The whole point: time-to-first-byte. The source below never writes, so a
    // proxy or browser watching an unwrapped response would see nothing at all.
    const { response } = sourceResponse();
    const reader = withSseKeepalive(response, { intervalMs: 15_000 }).body!.getReader();
    expect(await readFrame(reader)).toBe(SSE_KEEPALIVE_FRAME);
  });

  it("keeps punctuating a long silence, one frame per interval", async () => {
    const { response, push } = sourceResponse();
    const reader = withSseKeepalive(response, { intervalMs: 1_000 }).body!.getReader();
    expect(await readFrame(reader)).toBe(SSE_KEEPALIVE_FRAME);

    // A deliberately slow tool call: nothing on the wire for three intervals.
    for (let beat = 0; beat < 3; beat += 1) {
      const next = readFrame(reader);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await next).toBe(SSE_KEEPALIVE_FRAME);
    }

    // And the real chunk still arrives when the model finally speaks.
    push("data: {\"type\":\"text-delta\"}\n\n");
    expect(await readFrame(reader)).toBe("data: {\"type\":\"text-delta\"}\n\n");
  });

  it("never buffers or delays a real chunk", async () => {
    const { response, push, end } = sourceResponse();
    const reader = withSseKeepalive(response, { intervalMs: 60_000 }).body!.getReader();
    expect(await readFrame(reader)).toBe(SSE_KEEPALIVE_FRAME);

    // No timer advance anywhere below: every frame must land on its own,
    // meaning the wrapper is not sitting on chunks waiting for a tick.
    push("data: a\n\n");
    expect(await readFrame(reader)).toBe("data: a\n\n");
    push("data: b\n\n");
    push("data: [DONE]\n\n");
    expect(await readFrame(reader)).toBe("data: b\n\n");
    expect(await readFrame(reader)).toBe("data: [DONE]\n\n");
    end();
    expect(await readFrame(reader)).toBe("<done>");
  });

  it("stops the moment the stream ends — no timer outlives the turn", async () => {
    const { response, end } = sourceResponse();
    const reader = withSseKeepalive(response, { intervalMs: 1_000 }).body!.getReader();
    await readFrame(reader);
    end();
    expect(await readFrame(reader)).toBe("<done>");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the consumer cancels", async () => {
    const { response } = sourceResponse();
    const wrapped = withSseKeepalive(response, { intervalMs: 1_000 });
    const reader = wrapped.body!.getReader();
    await readFrame(reader);
    await reader.cancel("gone");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a source error instead of hiding it behind keepalives", async () => {
    const { response, fail } = sourceResponse();
    const reader = withSseKeepalive(response, { intervalMs: 1_000 }).body!.getReader();
    await readFrame(reader);
    fail(new Error("provider exploded"));
    await expect(reader.read()).rejects.toThrow("provider exploded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the response status and headers", () => {
    const { response } = sourceResponse({ "content-type": "text/event-stream", "x-vendo-thread-id": "thr_1" });
    const wrapped = withSseKeepalive(response);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("x-vendo-thread-id")).toBe("thr_1");
  });

  it("passes a bodyless response through untouched", () => {
    const empty = new Response(null, { status: 204 });
    expect(withSseKeepalive(empty)).toBe(empty);
  });
});
