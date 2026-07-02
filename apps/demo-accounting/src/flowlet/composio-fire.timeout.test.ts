import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendGmail, createCalendarEvent } from "./composio-fire";

const priorKey = process.env.COMPOSIO_API_KEY;

beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test-key";
});
afterEach(() => {
  if (priorKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = priorKey;
});

/** A fetch that never responds until the request's AbortSignal fires — the
 *  real "Gmail stalled mid-send" shape. Real fetch rejects with an AbortError
 *  when its signal aborts, so we mirror that. */
const stallFetch: typeof fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // would hang — but the executor always passes one
    signal.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted", "AbortError")),
    );
  })) as unknown as typeof fetch;

describe("composio executor stall protection", () => {
  it("a stalled Gmail send FAILS LOUD as a timeout, not a hang", async () => {
    const result = await sendGmail(
      { recipient_email: "yousef+rivera@vendo.run", subject: "s", body: "b" },
      { fetchImpl: stallFetch, timeoutMs: 25 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("a stalled Calendar create also times out", async () => {
    const result = await createCalendarEvent(
      { summary: "s", start_datetime: "2026-07-02T14:00:00" },
      { fetchImpl: stallFetch, timeoutMs: 25 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("a fast success still returns ok (timeout does not fire)", async () => {
    const okFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ successful: true, data: { id: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await sendGmail(
      { recipient_email: "yousef+rivera@vendo.run", subject: "s", body: "b" },
      { fetchImpl: okFetch, timeoutMs: 25 },
    );
    expect(result.ok).toBe(true);
  });
});
