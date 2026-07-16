import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, ephemeralOverlaySizes, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

// Minimal streaming model: one text turn per call, never exhausts. Enough to
// drive a chat turn end-to-end so an ephemeral thread lands in the overlay.
const chatModel = (): LanguageModel => ({
  specificationVersion: "v2",
  provider: "vendo-session-lifecycle",
  modelId: "vendo-session-lifecycle-v1",
  supportedUrls: {},
  async doStream() {
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
          controller.close();
        },
      }),
    };
  },
} as unknown as LanguageModel);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const hostPrincipal: Principal = { kind: "user", subject: "user_host" };

interface Harness {
  vendo: Vendo;
  store: VendoStore;
  setNow: (value: number) => void;
}

async function harness(sessions: CreateVendoConfig["sessions"]): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-session-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  let now = 0;
  const vendo = createVendo({
    model: chatModel(),
    // Anonymous by default; an x-host header resolves a durable host principal,
    // used to trigger a sweep without registering a new anonymous subject.
    principal: async (req) => (req.headers.get("x-host") === null ? null : hostPrincipal),
    store,
    sessions: { ...sessions, now: () => now },
  });
  return { vendo, store, setNow: (value) => { now = value; } };
}

const cookieOf = (res: Response): string => {
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no anonymous cookie was minted");
  return setCookie.split(";")[0]!; // name=value
};

const chat = (cookie?: string, id = "m1"): Request =>
  new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ message: { id, role: "user", parts: [{ type: "text", text: "hi" }] } }),
  });

const listThreads = (cookie?: string): Request =>
  new Request("https://host.test/api/vendo/threads", {
    headers: cookie === undefined ? {} : { cookie },
  });

// A durable host request that only serves to run the amortized on-request sweep
// at the current clock — it registers no ephemeral subject.
const hostSweep = (): Request =>
  new Request("https://host.test/api/vendo/threads", { headers: { "x-host": "1" } });

// Draining the body releases the request's inflight refcount (and, for a chat
// turn, lets onFinish persist the thread).
const drain = async (res: Response): Promise<void> => { await res.text(); };

describe("ephemeral session lifecycle through the umbrella (ENG-237)", () => {
  it("creates, touches, and idle-evicts an anonymous session (store overlay cascaded)", async () => {
    const { vendo, store, setNow } = await harness({ ttlMs: 1000, sweepIntervalMs: 100 });

    // (create) an anon chat turn → a session + an ephemeral thread in the overlay.
    setNow(0);
    const first = await vendo.handler(chat());
    const cookie = cookieOf(first);
    await drain(first);
    expect(ephemeralOverlaySizes(store).subjects).toBe(1);
    expect(ephemeralOverlaySizes(store).threads).toBe(1);

    // (touch) a request inside the TTL refreshes the session — no eviction.
    setNow(1500); // 1500 - 0 = 1500 idle, but the touch below re-stamps to 1500
    await drain(await vendo.handler(listThreads(cookie)));
    // A host sweep now: the session was just touched at 1500, so 1500-1500 < ttl.
    await drain(await vendo.handler(hostSweep()));
    expect(ephemeralOverlaySizes(store).subjects).toBe(1);
    expect(ephemeralOverlaySizes(store).threads).toBe(1);

    // (idle eviction) advance past the TTL and sweep via a host request — the
    // whole overlay is cascaded away for the idle subject.
    setNow(3000);
    await drain(await vendo.handler(hostSweep()));
    const sizes = ephemeralOverlaySizes(store);
    expect(sizes.subjects).toBe(0);
    expect(sizes.threads).toBe(0);
    expect(sizes.apps).toBe(0);

    // (fresh session) the old cookie still works — it just gets a new, empty session.
    setNow(3100);
    const relisted = await vendo.handler(listThreads(cookie));
    expect(relisted.status).toBe(200);
    await drain(relisted);
    expect(ephemeralOverlaySizes(store).subjects).toBe(1); // re-registered, empty
    expect(ephemeralOverlaySizes(store).threads).toBe(0);
  });

  it("never evicts a session with an in-flight request (inflight refcount)", async () => {
    const { vendo, store, setNow } = await harness({ ttlMs: 1000, sweepIntervalMs: 100 });
    setNow(0);
    const first = await vendo.handler(chat());
    const cookie = cookieOf(first);
    await drain(first);

    // Start a second request on the same cookie but DO NOT drain it — its
    // inflight refcount stays held.
    setNow(100);
    const held = await vendo.handler(listThreads(cookie));

    // Advance well past the TTL and sweep: the held session must be skipped.
    setNow(5000);
    await drain(await vendo.handler(hostSweep()));
    expect(ephemeralOverlaySizes(store).subjects).toBe(1); // survived — inflight
    expect(ephemeralOverlaySizes(store).threads).toBe(1);

    // Release it; now it is sweepable.
    await drain(held);
    setNow(9000);
    await drain(await vendo.handler(hostSweep()));
    expect(ephemeralOverlaySizes(store).subjects).toBe(0);
  });

  it("ttlMs: 0 disables TTL eviction (cap-only)", async () => {
    const { vendo, store, setNow } = await harness({ ttlMs: 0, sweepIntervalMs: 100 });
    setNow(0);
    await drain(await vendo.handler(chat()));
    expect(ephemeralOverlaySizes(store).subjects).toBe(1);

    // No amount of idle time evicts when TTL is off.
    setNow(10 ** 9);
    await drain(await vendo.handler(hostSweep()));
    expect(ephemeralOverlaySizes(store).subjects).toBe(1);
    expect(ephemeralOverlaySizes(store).threads).toBe(1);
  });

  it("keeps memory flat under anonymous-session churn (feeds Wave 6 resilience demo)", async () => {
    const { vendo, store, setNow } = await harness({ ttlMs: 100, sweepIntervalMs: 50 });
    const N = 1000;
    let clock = 0;
    for (let i = 0; i < N; i += 1) {
      clock += 1000; // each new visitor arrives long after the previous went idle
      setNow(clock);
      // A fresh anonymous visitor (no cookie) does one chat turn, then leaves.
      await drain(await vendo.handler(chat(undefined, `m_${i}`)));
    }
    // A final host sweep well past the last visitor's TTL drains the registry.
    setNow(clock + 10_000);
    await drain(await vendo.handler(hostSweep()));

    // Structural memory flatness (RSS flakes in CI, so assert sizes): every
    // overlay map and the registry are empty after churn...
    for (const [name, size] of Object.entries(ephemeralOverlaySizes(store))) {
      expect(size, name).toBe(0);
    }
    // ...and nothing ever leaked to disk (ephemeral threads never persisted).
    const rows = (store.raw() as { query<T>(text: string): Promise<{ rows: T[] }> });
    const records = await rows.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM vendo_records");
    const threads = await rows.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM vendo_threads");
    expect(Number((records.rows[0] as { count: number }).count)).toBe(0);
    expect(Number((threads.rows[0] as { count: number }).count)).toBe(0);
  }, 60_000);
});
