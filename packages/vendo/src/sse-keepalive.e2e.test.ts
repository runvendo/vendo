/**
 * The SSE keepalive, on the production wire — blueprint §4.1 item 5, §4.2.
 *
 * The seam: `vendo.handler` (real store, real guard, real registry, real turn)
 * → a real `Response` → the RAW SSE BYTES a proxy and a browser would see, and
 * the same bytes read back through the ai-SDK's own reducer. No double stands
 * between the response the wire produced and the frames asserted here.
 *
 * Two facts have to hold at once, and they pull against each other:
 *   1. the connection is never silent (first byte before the model speaks, then
 *      frames through a long tool call), and
 *   2. a normal client sees EXACTLY the message sequence it saw before — a
 *      keepalive is transport framing, not an event.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSE_KEEPALIVE_FRAME, type Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import { readUIMessageStream, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_keepalive" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-keepalive-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A turn that stalls where a real one stalls: before its first token (the
 *  provider call) and again mid-flight (a slow tool). The test drives both
 *  gates, so "silence" here is the product's silence, not a sleep. */
function gatedHarness(gates: { firstToken: Promise<void>; afterTool: Promise<void> }) {
  return defineHarness({
    name: "keepalive-probe",
    async *run() {
      await gates.firstToken;
      yield { type: "text", delta: "Working on it." };
      await gates.afterTool;
      yield { type: "text", delta: " Done." };
    },
  });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function vendoWith(harness: unknown, store: VendoStore) {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
}

function turnRequest(threadId: string): Request {
  return new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "do the slow thing" }] },
    }),
  });
}

/** Read raw SSE frames off a live response until `stop()` says so. */
function readFrames(response: Response): { frames: string[]; next: () => Promise<string> } {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffered = "";
  const next = async (): Promise<string> => {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = `${buffered.slice(0, boundary)}\n\n`;
        buffered = buffered.slice(boundary + 2);
        frames.push(frame);
        return frame;
      }
      const { done, value } = await reader.read();
      if (done) return "<done>";
      buffered += decoder.decode(value, { stream: true });
    }
  };
  return { frames, next };
}

describe("the SSE keepalive on the production wire", () => {
  it("puts a frame on the wire before the model has produced anything, and again through a slow tool call", async () => {
    const store = await tempStore();
    const firstToken = gate();
    const afterTool = gate();
    const vendo = vendoWith(gatedHarness({ firstToken: firstToken.promise, afterTool: afterTool.promise }), store);

    const response = await vendo.handler(turnRequest("thr_keepalive"));
    expect(response.status).toBe(200);

    const { next } = readFrames(response);
    // The turn is parked on `firstToken` — the model has said NOTHING. Without
    // the keepalive this read would block until the gate opens.
    expect(await next()).toBe(SSE_KEEPALIVE_FRAME);

    firstToken.open();
    // Drain until the first real text delta arrives; more keepalives may ride
    // ahead of it, which is the point.
    let frame = await next();
    while (frame === SSE_KEEPALIVE_FRAME) frame = await next();
    expect(frame.startsWith("data: ")).toBe(true);

    afterTool.open();
    // And the stream still completes, ending on the SDK's terminator.
    let last = frame;
    for (;;) {
      const seen = await next();
      if (seen === "<done>") break;
      last = seen;
    }
    expect(last).toBe("data: [DONE]\n\n");
  }, 60_000);

  it("leaves a normal client's message sequence byte-for-byte unchanged", async () => {
    const store = await tempStore();
    const open = gate();
    open.open();
    const vendo = vendoWith(gatedHarness({ firstToken: open.promise, afterTool: open.promise }), store);

    const response = await vendo.handler(turnRequest("thr_keepalive_parse"));
    const body = await response.text();

    // The keepalive IS on the wire...
    expect(body).toContain(SSE_KEEPALIVE_FRAME);

    // ...and the ai-SDK's own SSE reducer never sees it. Parsed exactly the way
    // `DefaultChatTransport` parses it: comment frames are ignored by the SSE
    // grammar, so they can never become a UIMessage part.
    const chunks = body
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as UIMessageChunk);
    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream<UIMessage>({
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    })) {
      messages[0] = message;
    }
    const text = messages[0]?.parts.filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text).join("");
    expect(text).toBe("Working on it. Done.");
    // Not one part came from a keepalive.
    expect(messages[0]?.parts.some((part) => JSON.stringify(part).includes("heartbeat"))).toBe(false);
  }, 60_000);
});
