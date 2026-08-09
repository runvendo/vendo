/**
 * Stream resume, both halves, no stub on either side — blueprint §4.1 item 5.
 *
 * The seam: the REAL client transport (`DefaultChatTransport` from `ai` — the
 * same class `useVendoThread` constructs, calling the same `reconnectToStream`
 * `useChat().resumeStream()` calls) against the REAL wire (`vendo.handler`, real
 * store, real guard, real turn). The transport's `fetch` hands requests to the
 * handler; that is the only plumbing, and it stubs neither the producer nor the
 * consumer.
 *
 * The claim under test: a client that loses its connection mid-turn and rejoins
 * ends with the SAME complete message as a client that never dropped. Anything
 * less than "same" is the feature not existing — a green suite around a resume
 * that returns half a reply is exactly the failure mode this repo keeps naming.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import {
  DefaultChatTransport,
  readUIMessageStream,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_resume" };
const OTHER: Principal = { kind: "user", subject: "user_stranger" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-resume-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Four text beats with a gate in the middle, so the test decides exactly when
 *  the turn crosses the point the client disappears at. No sleeps: the timing is
 *  the product's, driven by the test, not by the clock. */
function beatingHarness(midTurn: Promise<void>) {
  return defineHarness({
    name: "resume-probe",
    async *run() {
      yield { type: "text", delta: "One." };
      yield { type: "text", delta: " Two." };
      await midTurn;
      yield { type: "text", delta: " Three." };
      yield { type: "text", delta: " Four." };
    },
  });
}

function vendoWith(harness: unknown, store: VendoStore, who: Principal = principal) {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => who,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
}

/** The transport the panel builds, pointed at the handler instead of a socket. */
function transportFor(vendo: { handler: (request: Request) => Promise<Response> }): DefaultChatTransport<UIMessage> {
  return new DefaultChatTransport<UIMessage>({
    api: "https://host.test/api/vendo/threads",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      vendo.handler(new Request(input as string, init))) as unknown as typeof fetch,
    prepareSendMessagesRequest: ({ messages, id }) => ({
      body: { threadId: id, message: messages.at(-1) },
    }),
  });
}

const userTurn = (): UIMessage => ({
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "count to four" }],
});

/** Assemble a chunk stream the way the SDK's own client does. */
async function assemble(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream<UIMessage>({ stream })) last = message;
  return last;
}

const textOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? []).filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text).join("");

describe("stream resume (blueprint §4.1 item 5)", () => {
  it("a client that drops mid-turn and reconnects ends with the same message as one that never dropped", async () => {
    // 1. The reference: an uninterrupted run.
    const clean = await tempStore();
    const cleanGate = gate();
    cleanGate.open();
    const cleanVendo = vendoWith(beatingHarness(cleanGate.promise), clean);
    const uninterrupted = await assemble(await transportFor(cleanVendo).sendMessages({
      chatId: "thr_clean",
      messages: [userTurn()],
      trigger: "submit-message",
      messageId: "m1",
      abortSignal: undefined,
    }));
    expect(textOf(uninterrupted)).toBe("One. Two. Three. Four.");

    // 2. The same turn, interrupted.
    const store = await tempStore();
    const midTurn = gate();
    const vendo = vendoWith(beatingHarness(midTurn.promise), store);
    const transport = transportFor(vendo);

    const live = await transport.sendMessages({
      chatId: "thr_resume",
      messages: [userTurn()],
      trigger: "submit-message",
      messageId: "m1",
      abortSignal: undefined,
    });
    // Read a bit of it, then vanish — the socket dies, the fetch is NEVER
    // aborted (a recycled isolate, a dropped connection, a closed tab on a
    // runtime that does not surface the disconnect). The turn keeps running.
    const reader = live.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel("connection lost");

    // The rest of the turn happens with nobody listening.
    midTurn.open();

    // 3. Rejoin through the REAL client path. Poll because the reconnect can
    //    legitimately land before the wire has registered anything; the budget
    //    is the test's own timeout, never a tighter inner clock.
    let resumed: ReadableStream<UIMessageChunk> | null = null;
    while (resumed === null) {
      resumed = await transport.reconnectToStream({ chatId: "thr_resume" });
      if (resumed === null) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const replayed = await assemble(resumed);

    // The whole point: same words, same shape, as if nothing had happened.
    expect(textOf(replayed)).toBe(textOf(uninterrupted));
    expect(replayed?.parts.map((part) => part.type)).toEqual(uninterrupted?.parts.map((part) => part.type));
  }, 60_000);

  it("answers 204 — not an error, not another principal's turn — when there is nothing to resume", async () => {
    const store = await tempStore();
    const open = gate();
    open.open();
    const vendo = vendoWith(beatingHarness(open.promise), store);

    // A thread that never ran.
    const cold = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_never/stream"));
    expect(cold.status).toBe(204);

    // A thread whose turn belongs to somebody else: the SAME 204, so the route
    // is not an oracle for another principal's activity.
    const midTurn = gate();
    const mine = vendoWith(beatingHarness(midTurn.promise), store);
    const live = await mine.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thr_mine", message: userTurn() }),
    }));
    const reader = live.body!.getReader();
    await reader.read();

    const stranger = vendoWith(beatingHarness(open.promise), store, OTHER);
    const foreign = await stranger.handler(new Request("https://host.test/api/vendo/threads/thr_mine/stream"));
    expect(foreign.status).toBe(204);

    // And the owner can still resume it, so the 204 above was about the
    // principal and not about an empty registry.
    const owned = await mine.handler(new Request("https://host.test/api/vendo/threads/thr_mine/stream"));
    expect(owned.status).toBe(200);
    expect(owned.headers.get("content-type")).toContain("text/event-stream");
    // The resumed consumer inherits the turn's liveness beat.
    expect(owned.headers.get("x-vendo-thread-id")).toBe("thr_mine");

    midTurn.open();
    await reader.cancel("done");
    await owned.body?.cancel();
  }, 60_000);
});
