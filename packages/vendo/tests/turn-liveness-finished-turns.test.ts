/**
 * ENG-353 follow-up — the idle watchdog and the turn's own closing work.
 *
 * A turn has two phases and they answer "the client vanished" differently. While
 * the thinker is STREAMING, a client that left is exactly what the watchdog is
 * for: nobody is waiting for the tokens still being generated. Once the last
 * token is out, the rest of the turn — the workspace commit that syncs back what
 * the agent built, then the transcript, the state and the audit row — is work the
 * person already paid for, and aborting it throws away what the turn just made.
 * The shipped failure: an abort landed during sync-back, the turn's app never
 * reached the store, the response was still a 200, and nothing was logged.
 *
 * The WHOLE chain, no stub on either side: the real wire routes, the real
 * liveness registry, the real harness runtime and a real store. The only thing
 * scripted is the thinker, because a unit test cannot run a model — and the
 * blob seam under the workspace is held open so the test can STAND inside the
 * closing phase instead of racing it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesAdapter, Principal, VendoLogEvent } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Generous margins: CI runners under coverage load stall for hundreds of
// milliseconds, and a spurious idle-abort here would flake the suite.
const IDLE_MS = 1_000;

const principal: Principal = { kind: "user", subject: "user_liveness" };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const turnBody = { message: { id: "m_ask", role: "user", parts: [{ type: "text", text: "build me a dashboard" }] } };
const beat = (vendo: Vendo, threadId: string): Promise<Response> =>
  vendo.handler(request("POST", `/threads/${threadId}/heartbeat`, {}));

/** What the scripted thinker leaves behind, and the reason it is BYTES: content
 *  past the inline cap lands through the blob seam, which is a host-suppliable
 *  adapter — so the test can hold the turn's sync-back open by holding it. */
const OUTPUT = new Uint8Array([0, 159, 146, 150, 255]);

interface Deployment {
  vendo: Vendo;
  /** Let the nth scripted thinker say its last word and end its turn. */
  finishThinking: (at?: number) => void;
  /** The nth turn's own abort signal, as the harness received it. */
  signal: (at?: number) => AbortSignal;
  /** Resolves once the turn's sync-back is landing the thinker's file: the
   *  runtime commits only after its loop has ended, so being here IS being past
   *  the last token, with the response still open. */
  syncingBack: Promise<void>;
  /** Let the sync-back finish. */
  releaseSyncBack: () => void;
  /** Everything the deployment's log seam was told. */
  logged: VendoLogEvent[];
}

async function deployment(): Promise<Deployment> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-finished-turn-"));
  const store = createStore({ dataDir });

  // One gate per turn a test starts, minted UP FRONT so a test can release a
  // turn before its thinker has reached the park.
  const gates = [0, 1].map(() => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open: () => open() };
  });
  let arriveSyncBack!: () => void;
  const syncingBack = new Promise<void>((resolve) => { arriveSyncBack = resolve; });
  let releaseSyncBack!: () => void;
  const syncedBack = new Promise<void>((resolve) => { releaseSyncBack = resolve; });
  cleanups.push(async () => {
    // Nothing parked at teardown: a thinker still awaiting — or a commit still
    // held — keeps the turn, and the suite, from ending.
    for (const gate of gates) gate.open();
    releaseSyncBack();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const blobs = new Map<string, Uint8Array>();
  const files: FilesAdapter = {
    put: async (key, bytes) => {
      // Only the thinker's own output is held; anything else the deployment
      // stores must not be gated behind a turn that has not run yet.
      if (bytes.length === OUTPUT.length && bytes.every((byte, at) => byte === OUTPUT[at])) {
        arriveSyncBack();
        await syncedBack;
      }
      blobs.set(key, bytes);
    },
    get: async (key) => {
      const bytes = blobs.get(key);
      return bytes === undefined ? undefined : { bytes };
    },
    delete: async (key) => { blobs.delete(key); },
  };

  const signals: AbortSignal[] = [];
  let started = 0;
  const harness = {
    name: "scripted-thinker",
    async *run(turn: { signal: AbortSignal; workspace: { writeFile: (path: string, content: Uint8Array) => Promise<void> } }) {
      const gate = gates[started++]!;
      signals.push(turn.signal);
      yield { type: "text" as const, delta: "here it is" };
      // Staged, not durable: the turn's own commit is what lands it.
      await turn.workspace.writeFile("/user/report.bin", OUTPUT);
      await gate.opened;
      yield { type: "text" as const, delta: " — done." };
    },
  };

  const logged: VendoLogEvent[] = [];
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    files,
    logger: (event) => logged.push(event),
    harness: harness as never,
  });
  return {
    vendo,
    finishThinking: (at = 0) => gates[at]!.open(),
    signal: (at = 0) => signals[at]!,
    syncingBack,
    releaseSyncBack,
    logged,
  };
}

describe("turn liveness — a finished turn's closing work is not the watchdog's to abort", () => {
  it("a client that goes quiet after the last token does not abort the turn's commit", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    const { vendo, finishThinking, signal, syncingBack, releaseSyncBack } = await deployment();

    const turn = await vendo.handler(request("POST", "/threads", turnBody));
    const threadId = turn.headers.get("x-vendo-thread-id")!;
    // One beat arms the watchdog — and then the tab goes away for good.
    expect(await (await beat(vendo, threadId)).json()).toEqual({ active: true });

    finishThinking();
    await syncingBack;
    // Where we are, said by the wire itself: the turn in flight no longer takes
    // words, because its thinker is done.
    const steered = await vendo.handler(request("POST", `/threads/${threadId}/steer`, {
      text: "one more thing",
      messageId: "m_late",
    }));
    expect(await steered.json()).toEqual({ landed: false });

    // Far past the idle window with no beat since. Mid-stream this is exactly an
    // abandoned turn; here it is a turn that already answered.
    await wait(IDLE_MS * 3);
    expect(signal().aborted).toBe(false);

    releaseSyncBack();
    await turn.text();

    // Read back through the REAL read path: the turn's answer landed.
    const thread = await (await vendo.handler(request("GET", `/threads/${threadId}`))).json() as {
      messages: Array<{ role: string; parts: unknown }>;
    };
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(thread.messages.at(-1)!.parts)).toContain("here it is");
  });

  it("still aborts a turn whose client goes quiet mid-stream", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    const { vendo, signal } = await deployment();

    // The thinker is never released: this turn is mid-stream throughout.
    const turn = await vendo.handler(request("POST", "/threads", turnBody));
    const threadId = turn.headers.get("x-vendo-thread-id")!;
    expect(await (await beat(vendo, threadId)).json()).toEqual({ active: true });
    expect(signal().aborted).toBe(false);

    await wait(IDLE_MS * 3);
    expect(signal().aborted).toBe(true);
  });

  it("standing one turn down leaves its sibling on the same thread still watched", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    const { vendo, finishThinking, signal, releaseSyncBack } = await deployment();
    // This test is about the sibling, not the commit: let the first turn close.
    releaseSyncBack();

    // Two turns in flight on ONE thread for one principal. Nothing serializes
    // them, which is exactly why the finish signal has to name a turn.
    const first = await vendo.handler(request("POST", "/threads", turnBody));
    const threadId = first.headers.get("x-vendo-thread-id")!;
    const second = await vendo.handler(request("POST", "/threads", {
      threadId,
      message: { id: "m_ask_again", role: "user", parts: [{ type: "text", text: "and a chart" }] },
    }));
    expect(second.headers.get("x-vendo-thread-id")).toBe(threadId);

    // The first turn finishes — thinker done, commit done, stream closed.
    finishThinking(0);
    await first.text();

    // The second is still streaming, and the beat still reaches it. Arming it
    // here rather than earlier keeps the test off the clock: what is being
    // checked is that this beat can still arm, not how fast the first turn was.
    expect(await (await beat(vendo, threadId)).json()).toEqual({ active: true });

    await wait(IDLE_MS * 3);
    expect(signal(1).aborted).toBe(true);
  });

  it("an idle abort says so: one log line, and a stream that ends instead of stopping", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    const { vendo, signal, logged } = await deployment();

    const turn = await vendo.handler(request("POST", "/threads", turnBody));
    const threadId = turn.headers.get("x-vendo-thread-id")!;
    // This client is still READING — only its beats stopped (a throttled tab).
    // It is the one that would otherwise spin on bytes that simply stop.
    const sending = turn.text();
    expect(await (await beat(vendo, threadId)).json()).toEqual({ active: true });

    await wait(IDLE_MS * 3);
    expect(signal().aborted).toBe(true);

    const sent = await sending;
    expect(sent).toContain("\"type\":\"error\"");
    expect(sent.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const idle = logged.find((event) => event.code === "vendo.turn-idle-abort");
    expect(idle?.level).toBe("warn");
    expect(idle?.message).toContain(threadId);
    expect(idle?.message).toContain(`${IDLE_MS}ms`);
  });
});
