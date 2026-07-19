import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTurnHeartbeat } from "./heartbeat.js";

// ENG-353 — panel-side turn heartbeat. While a wire turn streams, the client
// beats POST /threads/:id/heartbeat so the server can idle-abort abandoned
// turns on runtimes that never surface the socket close (`next dev`). The
// helper wraps the turn Response: beats start when the response arrives and
// stop the moment the stream ends, errors, is cancelled, or the wire answers
// active: false.

const encoder = new TextEncoder();

function streamedResponse(headers: Record<string, string>): {
  response: Response;
  push: (text: string) => void;
  end: () => void;
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
  };
}

const beatUrl = "https://host.test/api/vendo/threads/thr_beat/heartbeat";

describe("withTurnHeartbeat (ENG-353)", () => {
  let beats: Array<{ url: string; init: RequestInit | undefined }>;
  let beatResult: { active: boolean };
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    beats = [];
    beatResult = { active: true };
    fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      beats.push({ url: String(url), init });
      return Response.json(beatResult);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const options = (intervalMs = 5_000) => ({
    baseUrl: "https://host.test/api/vendo",
    headers: { "x-host": "1" },
    intervalMs,
    fetch: fetchImpl,
  });

  it("beats immediately and on the interval while the stream is open, then stops at stream end", async () => {
    const { response, push, end } = streamedResponse({ "x-vendo-thread-id": "thr_beat" });
    const wrapped = withTurnHeartbeat(response, options());

    await vi.advanceTimersByTimeAsync(0);
    expect(beats).toHaveLength(1);
    expect(beats[0]?.url).toBe(beatUrl);
    expect(beats[0]?.init?.method).toBe("POST");
    expect(new Headers(beats[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(beats[0]?.init?.headers).get("x-host")).toBe("1");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(beats).toHaveLength(2);

    // Consume the stream to its natural end — beats must stop.
    push("data: x\n\n");
    end();
    const reader = wrapped.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats).toHaveLength(2);
  });

  it("stops beating when the wire answers active: false", async () => {
    const { response } = streamedResponse({ "x-vendo-thread-id": "thr_beat" });
    beatResult = { active: false };
    withTurnHeartbeat(response, options());

    await vi.advanceTimersByTimeAsync(0);
    expect(beats).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats).toHaveLength(1);
  });

  it("stops beating when the consumer cancels (fetch abort fast path)", async () => {
    const { response } = streamedResponse({ "x-vendo-thread-id": "thr_beat" });
    const wrapped = withTurnHeartbeat(response, options());

    await vi.advanceTimersByTimeAsync(0);
    expect(beats).toHaveLength(1);
    await wrapped.body!.cancel();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats).toHaveLength(1);
  });

  it("passes through responses without a thread id, body, or ok status", async () => {
    const plain = new Response("nope", { status: 400 });
    expect(withTurnHeartbeat(plain, options())).toBe(plain);

    const headerless = streamedResponse({}).response;
    expect(withTurnHeartbeat(headerless, options())).toBe(headerless);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats).toHaveLength(0);
  });

  it("keeps beating through transient beat failures", async () => {
    const { response } = streamedResponse({ "x-vendo-thread-id": "thr_beat" });
    vi.mocked(fetchImpl).mockRejectedValueOnce(new Error("network blip"));
    withTurnHeartbeat(response, options());

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(beats.length).toBeGreaterThanOrEqual(1); // the rejected call + the retry tick
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves the response status and headers on the wrapped response", () => {
    const { response } = streamedResponse({ "x-vendo-thread-id": "thr_beat", "content-type": "text/event-stream" });
    const wrapped = withTurnHeartbeat(response, options());
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("x-vendo-thread-id")).toBe("thr_beat");
  });
});
