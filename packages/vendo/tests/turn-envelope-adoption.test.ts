/**
 * The turn envelopes, ADOPTED — and the per-op path they fall back to, proven
 * in the same file because a suite that only ever runs one of them proves half
 * the feature.
 *
 * Both stores below are the SAME real store: PGlite rows, the real
 * `createStoreOps` over them, the real composition, the real `vendo()` harness,
 * a real turn. They differ in exactly ONE byte of behaviour — the op level
 * `/status` reports — which is the only thing a client is allowed to route on
 * (#1251: a failed mutation is not a capability answer). So the envelope turn
 * and the fallback turn are the same turn against the same rows, and the only
 * thing that can differ is how many calls it took.
 *
 * The ops are counted at the handle, where one op IS one wire call for a hosted
 * deployment (`hostedStoreOps` posts once per op).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORE_WIRE_TURN_OPS,
  VENDO_STORE_WIRE_FORMAT,
  type Harness,
  type Principal,
  type RecordInput,
  type RecordQuery,
  type StoreOps,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, createStoreOps, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel, textTurn } from "../src/agent-doubles.test-util.js";
import { createVendo, type CreateVendoConfig } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_envelope" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every op this handle serves, named `family.verb`, in call order. */
function countedOps(real: StoreOps, level: number, seen: string[]): StoreOps {
  const countFamily = (family: string, target: Record<string, unknown>): unknown => new Proxy(target, {
    get(inner, verb) {
      const value = Reflect.get(inner, verb) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        seen.push(`${family}.${String(verb)}`);
        return (value as (...a: unknown[]) => unknown).apply(inner, args);
      };
    },
  });
  return new Proxy(real, {
    get(target, key) {
      const name = String(key);
      // The ONE handshake, answering the level this mount is pretending to be.
      if (name === "status") {
        return () => {
          seen.push("status");
          return Promise.resolve({ format: VENDO_STORE_WIRE_FORMAT, ops: level });
        };
      }
      const value = Reflect.get(target, key) as unknown;
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          seen.push(name);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value !== null && typeof value === "object") return countFamily(name, value as Record<string, unknown>);
      return value;
    },
  });
}

/**
 * A store the way a hosted deployment presents one: NO SQL handle, so every
 * door goes through the ops — including the record façade, which is what makes
 * the thread read cost a call here exactly as it does on the wire
 * (`hostedStore` routes `records()` onto the engine family the same way).
 */
function hostedShape(backing: VendoStore, level: number, seen: string[]): VendoStore {
  const ops = countedOps(createStoreOps(backing), level, seen);
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

interface Deployment {
  say(text: string, id: string): Promise<number>;
  messageIds(): Promise<string[]>;
  seen: string[];
}

async function deploy(level: number, harness?: Harness<never>): Promise<Deployment> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-turn-envelope-"));
  const backing = createStore({ dataDir });
  cleanups.push(async () => { await backing.close(); await rm(dataDir, { recursive: true, force: true }); });
  await backing.ensureSchema();
  const seen: string[] = [];
  const vendo = createVendo({
    models: { default: scriptedModel([textTurn("one"), textTurn("two")]) as unknown as LanguageModel },
    principal: async () => principal,
    store: hostedShape(backing, level, seen),
    ...(harness === undefined ? {} : { harness }),
  } as CreateVendoConfig);

  const thread = "thr_envelope";
  return {
    seen,
    async say(text, id) {
      const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread, message: { id, role: "user", parts: [{ type: "text", text }] } }),
      }));
      await response.text();
      return response.status;
    },
    async messageIds() {
      const listed = await vendo.harness.threads.get(thread, {
        principal, venue: "chat", presence: "present", sessionId: "s_envelope",
      });
      return (listed?.messages ?? []).filter((message) => message.role === "user").map((message) => message.id);
    },
  };
}

describe("the turn envelope, adopted", () => {
  it("a mount that serves it spends ONE call opening the turn and ONE closing it", async () => {
    const deployment = await deploy(STORE_WIRE_TURN_OPS);
    expect(await deployment.say("first", "m_first")).toBe(200);

    // Turn TWO is the representative turn: the conversation exists, so nothing
    // here is first-turn setup.
    deployment.seen.length = 0;
    expect(await deployment.say("second", "m_second")).toBe(200);

    const perTurn = deployment.seen.filter((op) => op !== "status");
    expect(perTurn).toContain("turn.load");
    expect(perTurn).toContain("turn.commit");
    // The reads the envelope now carries are not made a second time.
    expect(perTurn).not.toContain("workspace.index");
    expect(perTurn).not.toContain("harness.get");
    expect(perTurn).not.toContain("harness.set");
    expect(perTurn).not.toContain("transcripts.getThread");
    // The whole turn, itemised. A quiet turn opens with the envelope, lands the
    // user's message before the model runs (a turn that dies must not lose it),
    // and closes with the envelope.
    expect(perTurn).toEqual(["turn.load", "transcripts.appendMessages", "turn.commit"]);
    expect(perTurn.length).toBeLessThanOrEqual(4);

    expect(await deployment.messageIds()).toEqual(["m_first", "m_second"]);
  });

  it("a mount BELOW the level runs the per-op path, unchanged", async () => {
    const deployment = await deploy(STORE_WIRE_TURN_OPS - 1);
    expect(await deployment.say("first", "m_first")).toBe(200);

    deployment.seen.length = 0;
    expect(await deployment.say("second", "m_second")).toBe(200);

    const perTurn = deployment.seen.filter((op) => op !== "status");
    // Never blind-sent: the envelope is not attempted at all below the level.
    expect(perTurn).not.toContain("turn.load");
    expect(perTurn).not.toContain("turn.commit");
    // …and every read and write it would have carried is made the old way.
    expect(perTurn).toContain("engine.get");
    expect(perTurn).toContain("workspace.index");
    expect(perTurn).toContain("harness.get");
    expect(perTurn).toContain("transcripts.appendMessages");

    // The SAME conversation lands, which is the point: the fallback is slower,
    // never different.
    expect(await deployment.messageIds()).toEqual(["m_first", "m_second"]);
  });

  /** A harness that OWNS a session: it resumes what the last turn stored and
   *  stores this turn's, which is the state the envelope has to carry. */
  const sessionHarness = (resumed: (string | undefined)[]): Harness<never> => defineHarness({
    name: "envelope-probe",
    async *run(turn) {
      resumed.push(turn.state.get());
      turn.state.set(`sess_${resumed.length}`);
      yield { type: "text", delta: "ok" } as const;
    },
  }) as Harness<never>;

  it("carries the harness state IN the commit, and reads it back next turn", async () => {
    const resumed: (string | undefined)[] = [];
    const deployment = await deploy(STORE_WIRE_TURN_OPS, sessionHarness(resumed));
    expect(await deployment.say("first", "m_first")).toBe(200);

    deployment.seen.length = 0;
    expect(await deployment.say("second", "m_second")).toBe(200);

    // Turn two resumed what turn one's COMMIT stored — so the state rode the
    // envelope, and the slot it landed in is the one the door reads.
    expect(resumed).toEqual([undefined, "sess_1"]);
    const perTurn = deployment.seen.filter((op) => op !== "status");
    expect(perTurn).toContain("turn.commit");
    // Not a second write beside the batch.
    expect(perTurn).not.toContain("harness.set");
    expect(perTurn).not.toContain("harness.get");
  });

  it("the fallback writes that same state through the door, one call at a time", async () => {
    const resumed: (string | undefined)[] = [];
    const deployment = await deploy(STORE_WIRE_TURN_OPS - 1, sessionHarness(resumed));
    expect(await deployment.say("first", "m_first")).toBe(200);

    deployment.seen.length = 0;
    expect(await deployment.say("second", "m_second")).toBe(200);

    // The SAME resumption, reached by the calls that predate the envelope.
    expect(resumed).toEqual([undefined, "sess_1"]);
    const perTurn = deployment.seen.filter((op) => op !== "status");
    expect(perTurn).toContain("harness.get");
    expect(perTurn).toContain("harness.set");
    expect(perTurn).not.toContain("turn.commit");
  });
});
