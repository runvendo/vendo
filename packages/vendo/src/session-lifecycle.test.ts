import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

// Minimal streaming model: one text turn per call, never exhausts. Enough to
// drive a chat turn end-to-end so an ephemeral thread lands on disk.
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
  count: (table: string, where?: string, params?: unknown[]) => Promise<number>;
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
  const count = async (table: string, where = "TRUE", params: unknown[] = []): Promise<number> => {
    const raw = store.raw() as { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };
    const result = await raw.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params,
    );
    return Number(result.rows[0]?.count);
  };
  return { vendo, store, setNow: (value) => { now = value; }, count };
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

// Draining the body lets a chat turn's onFinish persist the thread.
const drain = async (res: Response): Promise<void> => { await res.text(); };

// Kill-list B3: anonymous sessions are disk rows (vendo_sessions registry +
// ordinary vendo_* rows under the anonymous subject); the TTL sweep erases them.
describe("ephemeral session lifecycle through the umbrella (02-store §4, kill-list B3)", () => {
  it("creates, touches, and idle-sweeps an anonymous session (disk rows erased)", async () => {
    const { vendo, setNow, count } = await harness({ ttlMs: 1000, sweepIntervalMs: 100 });

    // (create) an anon chat turn → a session row + a thread row on disk.
    setNow(0);
    const first = await vendo.handler(chat());
    const cookie = cookieOf(first);
    await drain(first);
    expect(await count("vendo_sessions")).toBe(1);
    expect(await count("vendo_threads", "subject LIKE 'anonymous\\_%'")).toBe(1);

    // (touch) a request inside the TTL refreshes the session — no eviction.
    // (A request arriving PAST the TTL would evict first: the amortized sweep
    // runs at the top of the handler, before the touch — evict-on-expiry.)
    setNow(900); // 900ms idle < 1000ms TTL; the touch re-stamps to 900
    await drain(await vendo.handler(listThreads(cookie)));
    // A host sweep at 1800: idle time is measured from the touch (900), so the
    // session is 900ms idle — still inside the TTL.
    setNow(1800);
    await drain(await vendo.handler(hostSweep()));
    expect(await count("vendo_sessions")).toBe(1);
    expect(await count("vendo_threads")).toBe(1);

    // (idle eviction) advance past the TTL and sweep via a host request — the
    // subject's rows are erased everywhere.
    setNow(3000);
    await drain(await vendo.handler(hostSweep()));
    expect(await count("vendo_sessions")).toBe(0);
    expect(await count("vendo_threads")).toBe(0);
    expect(await count("vendo_apps")).toBe(0);

    // (fresh session) the old cookie still works — it just gets a new, empty session.
    setNow(3100);
    const relisted = await vendo.handler(listThreads(cookie));
    expect(relisted.status).toBe(200);
    expect((await relisted.json()) as unknown[]).toEqual([]);
    expect(await count("vendo_sessions")).toBe(1); // re-registered, empty
    expect(await count("vendo_threads")).toBe(0);
  });

  it("ttlMs: 0 disables TTL eviction", async () => {
    const { vendo, setNow, count } = await harness({ ttlMs: 0, sweepIntervalMs: 100 });
    setNow(0);
    await drain(await vendo.handler(chat()));
    expect(await count("vendo_sessions")).toBe(1);

    // No amount of idle time evicts when TTL is off.
    setNow(10 ** 9);
    await drain(await vendo.handler(hostSweep()));
    expect(await count("vendo_sessions")).toBe(1);
    expect(await count("vendo_threads")).toBe(1);
  });

  it("keeps the store flat under anonymous-session churn (feeds Wave 6 resilience demo)", async () => {
    const { vendo, setNow, count } = await harness({ ttlMs: 100, sweepIntervalMs: 50 });
    const N = 150;
    let clock = 0;
    for (let i = 0; i < N; i += 1) {
      clock += 1000; // each new visitor arrives long after the previous went idle
      setNow(clock);
      // A fresh anonymous visitor (no cookie) does one chat turn, then leaves.
      await drain(await vendo.handler(chat(undefined, `m_${i}`)));
    }
    // A final host sweep well past the last visitor's TTL drains everything:
    // sessions, threads, and any other anon rows.
    setNow(clock + 10_000);
    await drain(await vendo.handler(hostSweep()));

    expect(await count("vendo_sessions")).toBe(0);
    expect(await count("vendo_threads")).toBe(0);
    expect(await count("vendo_records")).toBe(0);
    expect(await count("vendo_apps")).toBe(0);
  }, 60_000);
});
