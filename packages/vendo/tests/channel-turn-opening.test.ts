/**
 * THE OPENING WRITE, BESIDE THE OPENING READ — and the two assertions that are
 * allowed to put it there.
 *
 * A turn's first store call reads the thread and its second writes the user's
 * message, and the second waits for the first because the FIRST one's answer
 * shapes it: `fresh` picks a guarded create over an append, the listing title is
 * derived from the messages that come back, and `validateUpsert` is the gate
 * that stops a client rewriting stored history before the write lands.
 *
 * None of those hold for a texted turn. The message was built in this process
 * from a delivery Cloud already authenticated, so there is no client to forge
 * anything; and the thread id came off the link row, which only carries one
 * because a turn already ran on it — so the row exists and already has its
 * title. Composition says both things at once by passing SERVER_AUTHORED, and
 * only composition can: it is a symbol, so it cannot arrive on a parsed JSON
 * body, and it is not exported from the package.
 *
 * Both halves are pinned here, because either one alone is a dead feature: the
 * door honouring a marker nobody sets, or composition setting a marker the door
 * ignores.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORE_WIRE_TURN_OPS,
  VENDO_STORE_WIRE_FORMAT,
  type Principal,
  type RecordInput,
  type RecordQuery,
  type RunContext,
  type StoreOps,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, createStoreOps, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelLink } from "../src/channel-links.js";
import { runChannelTurn } from "../src/channel-turn.js";
import { SERVER_AUTHORED } from "../src/harness-turn.js";
import { createVendo, type CreateVendoConfig } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_opening" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_opening" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every op this handle serves, logged as it STARTS and again as it settles —
 *  which is the only way to see two calls overlap rather than merely follow one
 *  another. One op is one wire call for a hosted deployment. */
function timedOps(real: StoreOps, log: string[]): StoreOps {
  const timed = (name: string, fn: unknown, self: unknown): unknown =>
    typeof fn !== "function" ? fn : async (...args: unknown[]) => {
      log.push(`start:${name}`);
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(self, args);
      } finally {
        log.push(`end:${name}`);
      }
    };
  const family = (name: string, target: Record<string, unknown>): unknown => new Proxy(target, {
    get: (inner, verb) => timed(`${name}.${String(verb)}`, Reflect.get(inner, verb), inner),
  });
  return new Proxy(real, {
    get(target, key) {
      const name = String(key);
      // The ONE handshake — answered without logging, so it never crowds the
      // ordering the cases below read.
      if (name === "status") {
        return () => Promise.resolve({ format: VENDO_STORE_WIRE_FORMAT, ops: STORE_WIRE_TURN_OPS });
      }
      const value = Reflect.get(target, key) as unknown;
      if (typeof value === "function") return timed(name, value, target);
      if (value !== null && typeof value === "object") return family(name, value as Record<string, unknown>);
      return value;
    },
  });
}

/** A store the way a hosted deployment presents one: no SQL handle, so every
 *  door goes through the ops and every read costs a call. */
function hostedShape(backing: VendoStore, log: string[]): VendoStore {
  const ops = timedOps(createStoreOps(backing), log);
  return {
    ops,
    records: (collection) => ({
      get: (id) => ops.engine.get(collection, id),
      put: (record: RecordInput) => ops.engine.put(collection, record),
      delete: (id) => ops.engine.delete(collection, id),
      list: (query?: RecordQuery) => ops.engine.list(collection, query),
      atomic: {
        insertIfAbsent: (record: RecordInput) => ops.engine.insertIfAbsent(collection, record),
        compareAndSwap: (record: RecordInput, revision: string) =>
          ops.engine.compareAndSwap(collection, record, revision),
      },
    }),
    blobs: (namespace) => backing.blobs(namespace),
    ensureSchema: () => backing.ensureSchema(),
    async close() {},
    raw() { throw new Error("a hosted store has no local database handle"); },
  };
}

const replying = defineHarness({
  name: "opening-probe",
  // eslint-disable-next-line require-yield
  async *run() {
    yield { type: "text", delta: "ok" } as const;
  },
});

const say = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

interface Deployment {
  stream: (message: UIMessage, trusted: boolean) => Promise<void>;
  titles: () => Promise<string[]>;
  log: string[];
}

async function deploy(): Promise<Deployment> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-turn-opening-"));
  const backing = createStore({ dataDir });
  cleanups.push(async () => { await backing.close(); await rm(dataDir, { recursive: true, force: true }); });
  await backing.ensureSchema();
  const log: string[] = [];
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: hostedShape(backing, log),
    harness: replying as never,
  } as CreateVendoConfig);

  const threadId = "thr_opening";
  return {
    log,
    async stream(message, trusted) {
      const response = await vendo.harness.stream({
        threadId,
        message,
        ctx,
        ...(trusted ? { [SERVER_AUTHORED]: true } : {}),
      });
      await response.text();
    },
    titles: async () => (await vendo.harness.threads.list(ctx)).map((summary) => summary.title),
  };
}

/** Did `write` go out while `read` was still outstanding? */
const overlapped = (log: string[], write: string, read: string): boolean =>
  log.indexOf(`start:${write}`) !== -1
  && log.indexOf(`end:${read}`) !== -1
  && log.indexOf(`start:${write}`) < log.indexOf(`end:${read}`);

describe("a turn's opening store calls", () => {
  it("sends the user's message BESIDE the envelope read when composition vouches for it", async () => {
    const deployment = await deploy();
    // Turn one creates the thread. Turn two is the representative warm turn: the
    // row exists and carries its title, which is what the marker asserts.
    await deployment.stream(say("m_first", "first"), false);

    deployment.log.length = 0;
    await deployment.stream(say("m_second", "second"), true);

    expect(overlapped(deployment.log, "transcripts.appendMessages", "turn.load")).toBe(true);
  });

  it("keeps the web turn's write BEHIND its read, where validateUpsert still gates it", async () => {
    const deployment = await deploy();
    await deployment.stream(say("m_first", "first"), false);

    deployment.log.length = 0;
    await deployment.stream(say("m_second", "second"), false);

    // THE CONTROL. Without the marker nothing moves: the write still waits for
    // the read, because the read is what proves the client is not rewriting
    // history. An unvouched turn must never take the fast path by accident.
    expect(overlapped(deployment.log, "transcripts.appendMessages", "turn.load")).toBe(false);
    expect(deployment.log).toContain("start:transcripts.appendMessages");
  });

  it("still names a thread the vouch was wrong about", async () => {
    // The vouch can be wrong: a thread deleted between two texts is gone by the
    // time the append reaches it, so the append CREATES the row — and it carries
    // no title, because a warm append must never overwrite the one a thread
    // already has. What names it is the turn's CLOSING commit, which derives the
    // title from the whole transcript. Pinned here because if that ever stops
    // being true, these rows list as "New thread" for good: every later text on
    // the thread vouches exactly the same way and appends title-less again.
    const deployment = await deploy();

    await deployment.stream(say("m_only", "what did I spend on food?"), true);

    expect(await deployment.titles()).toEqual(["what did I spend on food?"]);
  });
});

const link: ChannelLink = {
  id: "chl_open",
  subject: "user_opening",
  phone: "+15551230123",
  linkedAt: "2026-08-17T10:22:10.710Z",
};

const event = {
  eventId: "evt_open",
  channel: "text" as const,
  from: "+15551230123",
  text: "what did I spend on food last month?",
  conversationId: "conv_open",
  receivedAt: "2026-08-17T10:22:11.211Z",
};

function turnDeps(captured: { input?: Record<PropertyKey, unknown> }) {
  return {
    harness: {
      stream: vi.fn(async (input: Record<PropertyKey, unknown>) => {
        captured.input = input;
        return new Response("data: {\"type\":\"text-delta\",\"delta\":\"ok\"}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    },
    guard: {
      onApprovalRequested: () => () => undefined,
      approvals: { pending: async () => [], decide: async () => undefined },
    },
    channel: { send: vi.fn(async () => undefined) },
    links: { rememberTurn: vi.fn(async () => undefined) },
    asks: { ids: async () => [], add: vi.fn(async () => undefined), consume: vi.fn(async () => undefined) },
  } as unknown as Parameters<typeof runChannelTurn>[0];
}

describe("what a texted turn vouches for", () => {
  it("vouches for the message when the link names a thread a turn already ran on", async () => {
    const captured: { input?: Record<PropertyKey, unknown> } = {};

    await runChannelTurn(turnDeps(captured), {
      event,
      link: { ...link, threadId: "thr_rolling", lastTurnAt: new Date().toISOString() },
    });

    expect(captured.input?.["threadId"]).toBe("thr_rolling");
    expect(captured.input?.[SERVER_AUTHORED]).toBe(true);
  });

  it("vouches for nothing when there is no live thread to append to", async () => {
    const captured: { input?: Record<PropertyKey, unknown> } = {};

    // No rolling thread — the row this turn opens may not exist yet, so the
    // door has to read before it writes, exactly as a web turn does.
    await runChannelTurn(turnDeps(captured), { event, link });

    expect(captured.input?.["threadId"]).toBeUndefined();
    expect(captured.input?.[SERVER_AUTHORED]).toBeUndefined();
  });

  it("vouches for nothing once the rolling thread has gone idle", async () => {
    const captured: { input?: Record<PropertyKey, unknown> } = {};

    await runChannelTurn(turnDeps(captured), {
      event,
      link: { ...link, threadId: "thr_stale", lastTurnAt: "2020-01-01T00:00:00.000Z" },
    });

    expect(captured.input?.["threadId"]).toBeUndefined();
    expect(captured.input?.[SERVER_AUTHORED]).toBeUndefined();
  });
});
