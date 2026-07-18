import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type StoreAdapter } from "@vendoai/core";
import { storeAdapterConformance } from "@vendoai/core/conformance";
import { createStore, secretStore, storeSecrets, type VendoStore } from "@vendoai/store";
import { hostedStore } from "./hosted-store.js";
import { fakeConsole } from "./hosted-store.test-util.js";

const encoder = new TextEncoder();


const hosted = (console_: ReturnType<typeof fakeConsole>) => hostedStore({
  apiKey: "vnd_secret",
  baseUrl: "https://cloud.test",
  fetch: console_.handler as unknown as typeof fetch,
});

describe("hostedStore conformance", () => {
  // The EXISTING StoreAdapter conformance suite (01-core §12 / 02-store §4),
  // run over the full HTTP round-trip against the in-memory console fake.
  const suite = storeAdapterConformance({
    async makeAdapter() {
      return { adapter: hosted(fakeConsole()) as StoreAdapter };
    },
  });
  for (const c of suite.cases) it(c.name, c.run);
});

describe("hostedStore wire", () => {
  it("speaks the console record wire shapes exactly, with key + deployment identity on every request", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    const records = store.records("invoices");

    const put = await records.put({ id: "inv_1", data: { total: 5 }, refs: { owner: "user_a" } });
    expect(put).toMatchObject({ id: "inv_1", data: { total: 5 }, refs: { owner: "user_a" } });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/records/invoices/put",
      contentType: "application/json",
      json: { record: { id: "inv_1", data: { total: 5 }, refs: { owner: "user_a" } } },
    });

    expect(await records.get("inv_1")).toEqual(put);
    expect(console_.requests[1]).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/get",
      json: { id: "inv_1" },
    });
    expect(await records.get("missing")).toBeNull();

    const listed = await records.list({ refs: { owner: "user_a" }, limit: 10 });
    expect(listed.records.map((record) => record.id)).toEqual(["inv_1"]);
    expect(console_.requests[3]).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/list",
      json: { query: { refs: { owner: "user_a" }, limit: 10 } },
    });

    // claim: present on non-reserved collections, absent on routed ones.
    expect(store.records("vendo_apps").claim).toBeUndefined();
    expect(records.claim).toBeDefined();
    await expect(records.claim!({ id: "inv_1", data: { total: 5 }, refs: { owner: "user_a" } })).resolves.toBe(true);
    expect(console_.requests[4]).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/claim",
      json: { expected: { id: "inv_1", data: { total: 5 }, refs: { owner: "user_a" } } },
    });
    expect(await records.get("inv_1")).toBeNull();

    // atomic: generic collections and vendo_threads carry it; other routed
    // collections and the dedicated door tables do not (engine mirror).
    expect(store.records("vendo_threads").atomic).toBeDefined();
    expect(store.records("vendo_apps").atomic).toBeUndefined();
    expect(store.records("vendo_mcp_clients").atomic).toBeUndefined();
    expect(store.records("vendo_mcp_clients").claim).toBeDefined();
    const inserted = await records.atomic!.insertIfAbsent({ id: "inv_2", data: { total: 7 } });
    expect(inserted?.revision).toBe("1");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/atomic/insert-if-absent",
      json: { record: { id: "inv_2", data: { total: 7 } } },
    });
    const swapped = await records.atomic!.compareAndSwap({ id: "inv_2", data: { total: 8 } }, "1");
    expect(swapped?.revision).toBe("2");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/atomic/compare-and-swap",
      json: { record: { id: "inv_2", data: { total: 8 } }, expectedRevision: "1" },
    });
    await expect(records.atomic!.compareAndSwap({ id: "inv_2", data: { total: 9 } }, "1")).resolves.toBeNull();

    await records.delete("inv_2");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/records/invoices/delete",
      json: { id: "inv_2" },
    });

    for (const request of console_.requests) {
      expect(request.authorization).toBe("Bearer vnd_secret");
      expect(request.deploymentHost).toEqual(expect.any(String));
      expect(request.deploymentHost).not.toBe("");
      expect(request.deploymentName).toEqual(expect.any(String));
      expect(request.deploymentName).not.toBe("");
    }
  });

  it("speaks the blob wire: raw bytes through the API, per-segment key encoding, prefix list, 404 → null", async () => {
    const console_ = fakeConsole();
    const blobs = hosted(console_).blobs("app:app_x:uploads");

    const bytes = new Uint8Array([0, 1, 2, 255]);
    await blobs.put("images/a b.png", bytes, { contentType: "image/png" });
    expect(console_.requests[0]).toMatchObject({
      method: "PUT",
      url: "https://cloud.test/api/v1/store/blobs/app%3Aapp_x%3Auploads/images/a%20b.png",
      contentType: "image/png",
      bytes,
    });

    const got = await blobs.get("images/a b.png");
    expect(got).not.toBeNull();
    expect(got!.bytes).toEqual(bytes);
    expect(got!.contentType).toBe("image/png");
    expect(await blobs.get("missing.bin")).toBeNull();

    await blobs.put("docs/readme.txt", encoder.encode("hi"));
    expect(await blobs.list("images/")).toEqual(["images/a b.png"]);
    expect(console_.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://cloud.test/api/v1/store/blobs/app%3Aapp_x%3Auploads?prefix=images%2F",
    });

    await blobs.delete("docs/readme.txt");
    expect(console_.requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://cloud.test/api/v1/store/blobs/app%3Aapp_x%3Auploads/docs/readme.txt",
    });
    expect(await blobs.list("")).toEqual(["images/a b.png"]);
  });

  it("speaks the session wire: register/adopt/stale/claim, millisecond clocks on the body", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    const base = Date.parse("2026-01-01T00:00:00Z");

    await store.sessions.register("anonymous_1", base);
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/sessions/register",
      json: { subject: "anonymous_1", now: base },
    });
    expect(console_.sessions.get("anonymous_1")).toBe(base);

    expect(await store.sessions.stale(30_000, base + 60_000)).toEqual(["anonymous_1"]);
    expect(console_.requests[1]).toMatchObject({
      url: "https://cloud.test/api/v1/store/sessions/stale",
      json: { idleMs: 30_000, now: base + 60_000 },
    });

    expect(await store.sessions.claim("anonymous_1", 30_000, base + 60_000)).toBe(true);
    expect(console_.requests[2]).toMatchObject({
      url: "https://cloud.test/api/v1/store/sessions/claim",
      json: { subject: "anonymous_1", idleMs: 30_000, now: base + 60_000 },
    });
    expect(await store.sessions.claim("anonymous_1", 30_000, base + 60_000)).toBe(false);

    await store.sessions.register("anonymous_2", base);
    expect(await store.sessions.adopt("anonymous_2", "user_signed")).toEqual({
      apps: 0, threads: 0, states: 0, skipped: 0,
    });
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/sessions/adopt",
      json: { from: "anonymous_2", to: "user_signed" },
    });
    // A replay finds nothing to merge — null, not an error.
    expect(await store.sessions.adopt("anonymous_2", "user_signed")).toBeNull();
  });

  it("speaks the erase wire: one POST per cascade, subject or app scoped", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    const bySubject = await store.erase.bySubject("user_gone");
    expect(bySubject).toEqual({ vendo_apps: 1, vendo_threads: 2 });
    const byApp = await store.erase.byApp("app_gone");
    expect(byApp).toEqual({ vendo_apps: 1, vendo_threads: 2 });
    expect(console_.eraseCalls).toEqual([{ subject: "user_gone" }, { appId: "app_gone" }]);
    expect(console_.requests.map((request) => request.url)).toEqual([
      "https://cloud.test/api/v1/store/erase",
      "https://cloud.test/api/v1/store/erase",
    ]);
  });

  it("defaults the base URL to the Vendo console", async () => {
    const cloudFetch = vi.fn(async () => Response.json({ record: null }));
    const store = hostedStore({ apiKey: "vnd_secret", fetch: cloudFetch as unknown as typeof fetch });
    await store.records("invoices").get("x");
    expect(cloudFetch.mock.calls[0]![0]).toBe("https://console.vendo.run/api/v1/store/records/invoices/get");
  });

  it("ensureSchema and close are client no-ops; raw has no local handle", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    await store.ensureSchema();
    await store.ensureSchema();
    await store.close();
    expect(console_.requests).toHaveLength(0);
    expect(() => store.raw()).toThrow(/no local database/);
  });
});

describe("hostedStore error mapping", () => {
  const adapterFor = (fetchImpl: unknown): VendoStore =>
    hostedStore({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl as typeof fetch });
  const respond = (code: string, message: string, status: number, extra: Record<string, unknown> = {}) =>
    vi.fn(async () => Response.json({ error: { code, message, ...extra } }, { status }));

  it("maps the console's quota gate (402) to cloud-required with the server's message", async () => {
    const store = adapterFor(respond("quota-exhausted", "Quota exhausted: upgrade or wait for period reset.", 402, { meter: "storage_gb" }));
    await expect(store.records("invoices").put({ id: "r", data: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Quota exhausted: upgrade or wait for period reset.",
    });
    await expect(store.blobs("files").put("k", new Uint8Array([1]))).rejects.toMatchObject({
      code: "cloud-required",
    });
  });

  it("maps a rejected key (401) to cloud-required with the server's message", async () => {
    const store = adapterFor(respond("unauthorized", "Valid API key required.", 401));
    await expect(store.records("invoices").get("r")).rejects.toMatchObject({
      code: "cloud-required",
      message: "Valid API key required.",
    });
  });

  it("forwards wire-legal VendoError codes as-is", async () => {
    await expect(
      adapterFor(respond("blocked", "vendo_audit is append-only", 403)).records("vendo_audit").delete("aud_1"),
    ).rejects.toMatchObject({ code: "blocked", message: "vendo_audit is append-only" });
    await expect(
      adapterFor(respond("validation", "bad id", 400)).records("vendo_state").delete("nope"),
    ).rejects.toMatchObject({ code: "validation", message: "bad id" });
    await expect(
      adapterFor(respond("conflict", "belongs to another subject", 409)).records("vendo_threads").put({ id: "thr_1", data: {} }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      adapterFor(respond("not-found", "unknown route", 404)).records("invoices").get("r"),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("carries unknown codes on a plain error and survives non-JSON bodies", async () => {
    await expect(
      adapterFor(respond("weird-code", "strange", 500)).records("invoices").get("r"),
    ).rejects.toMatchObject({ code: "weird-code", message: "strange" });
    const nonJson = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(adapterFor(nonJson).records("invoices").get("r"))
      .rejects.toThrow(/502/);
  });

  it("treats malformed 200 responses as service misbehavior — never the caller's fault", async () => {
    await expect(adapterFor(vi.fn(async () => Response.json({ record: { id: 42 } }))).records("invoices").get("r"))
      .rejects.toThrow(/invalid record/);
    await expect(adapterFor(vi.fn(async () => Response.json({}))).records("invoices").put({ id: "r", data: {} }))
      .rejects.toThrow(/invalid record/);
    await expect(adapterFor(vi.fn(async () => Response.json({ records: "nope" }))).records("invoices").list())
      .rejects.toThrow(/invalid list/);
    await expect(adapterFor(vi.fn(async () => Response.json({ claimed: "yes" }))).records("invoices").claim!({ id: "r", data: {} }))
      .rejects.toThrow(/invalid claim/);
    await expect(adapterFor(vi.fn(async () => Response.json({}))).erase.bySubject("user_x"))
      .rejects.toThrow(/invalid erase/);
    await expect(adapterFor(vi.fn(async () => Response.json({ keys: [1] }))).blobs("files").list())
      .rejects.toThrow(/invalid blob list/);
    const hostedFor = (fetchImpl: unknown) =>
      hostedStore({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl as typeof fetch });
    await expect(hostedFor(vi.fn(async () => Response.json({}))).sessions.stale(1_000))
      .rejects.toThrow(/invalid stale/);
    await expect(hostedFor(vi.fn(async () => Response.json({ claimed: "yes" }))).sessions.claim("s", 1_000))
      .rejects.toThrow(/invalid claim/);
    await expect(hostedFor(vi.fn(async () => Response.json({ report: "moved" }))).sessions.adopt("a", "b"))
      .rejects.toThrow(/invalid adopt/);
  });
});

describe("hostedStore exclusions", () => {
  it("has no secrets surface: the secrets doors require the local store and the wire never carries vendo_secrets", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    // storeSecrets/secretStore are functions of the LOCAL VendoStore handle
    // (dbFor); the hosted adapter is excluded by construction.
    expect(() => storeSecrets(store)).toThrow(/Unknown VendoStore handle/);
    expect(() => secretStore(store)).toThrow(/Unknown VendoStore handle/);
    expect(console_.requests).toHaveLength(0);
  });
});

describe("adapter rule", () => {
  it("hostedStore never reads the environment: behavior comes only from constructor arguments", async () => {
    // Cloned from sandbox.test.ts per that test's instruction to lanes
    // cloning the pattern.
    const WATCHED_ENV_PREFIXES = ["VENDO_"];
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy({
      ...realEnv,
      VENDO_API_KEY: "vnd_env",
      VENDO_CLOUD_URL: "https://env.test",
      VENDO_STORE_ENCRYPTION_KEY: "env-encryption-key",
    }, {
      get(target, property) {
        if (typeof property === "string") reads.push(property);
        return target[property as keyof typeof target];
      },
    });
    try {
      const console_ = fakeConsole();
      const store = hostedStore({
        apiKey: "vnd_arg",
        baseUrl: "https://arg.test",
        fetch: console_.handler as unknown as typeof fetch,
      });
      await store.records("invoices").put({ id: "r", data: {} });
      await store.blobs("files").put("k", new Uint8Array([1]));
      expect(console_.requests[0]!.url).toContain("https://arg.test/");
      expect(console_.requests[0]!.authorization).toBe("Bearer vnd_arg");
      expect(reads.filter((name) => WATCHED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))))
        .toEqual([]);
    } finally {
      process.env = realEnv;
    }
  });
});

/** The acceptance journey: the demo-host data shapes (apps, threads,
 * approvals, automation-run rows, blobs, state, audit) driven through ONE
 * routine against BOTH implementations of the store seam — hostedStore over
 * the fake console, and the local PGlite engine. Reserved-collection
 * semantics must hold identically on both sides of the wire. */
async function demoHostJourney(store: VendoStore): Promise<void> {
  const subject = "user_maple";
  const now = new Date().toISOString();

  // App document (the shape the apps block persists through the seam).
  const doc = {
    format: "vendo/app@1",
    id: "app_budget",
    name: "Budget",
    ui: "tree" as const,
    tree: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { value: "Track spend" } }],
    },
  };
  const apps = store.records("vendo_apps");
  await apps.put({ id: "app_budget", data: { subject, enabled: true, doc } });
  const appRow = await apps.get("app_budget");
  expect(appRow?.refs).toMatchObject({ subject });
  // Cross-subject flips are refused at the door on both engines.
  await expect(apps.put({ id: "app_budget", data: { subject: "user_mallory", enabled: true, doc } }))
    .rejects.toMatchObject({ code: "conflict" });

  // Threads: put + guarded writes (revision counter) + subject listing.
  const threads = store.records("vendo_threads");
  const inserted = await threads.atomic!.insertIfAbsent({
    id: "thr_journey",
    data: { subject, messages: [{ role: "user", content: "hello" }] },
    refs: { subject },
  });
  expect(inserted?.revision).toBe("1");
  await expect(threads.atomic!.insertIfAbsent({ id: "thr_journey", data: { subject, messages: [] } }))
    .resolves.toBeNull();
  const swapped = await threads.atomic!.compareAndSwap({
    id: "thr_journey",
    data: { subject, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] },
    refs: { subject },
  }, "1");
  expect(swapped?.revision).toBe("2");
  await expect(threads.atomic!.compareAndSwap({ id: "thr_journey", data: { subject, messages: [] } }, "1"))
    .resolves.toBeNull();
  const threadList = await threads.list({ refs: { subject } });
  expect(threadList.records.map((record) => record.id)).toEqual(["thr_journey"]);

  // Approvals (the guard's pending-approval row).
  const approvals = store.records("vendo_approvals");
  const request = {
    id: "apr_journey",
    call: { id: "call_1", tool: "host_send", args: {} },
    descriptor: { name: "host_send", description: "send", inputSchema: { type: "object" }, risk: "write" },
    inputPreview: "send it",
    ctx: {
      principal: { kind: "user", subject },
      venue: "chat",
      presence: "present",
      sessionId: "session_journey",
    },
    createdAt: now,
  };
  await approvals.put({ id: "apr_journey", data: { request, status: "pending" } });
  const pending = await approvals.list({ refs: { subject, status: "pending" } });
  expect(pending.records.map((record) => record.id)).toEqual(["apr_journey"]);

  // Automation run rows.
  const runs = store.records("vendo_runs");
  await runs.put({
    id: "run_journey",
    data: {
      appId: "app_budget",
      trigger: { kind: "schedule" },
      status: "ok",
      record: { steps: 1 },
      startedAt: now,
      finishedAt: now,
    },
  });
  const runList = await runs.list({ refs: { app_id: "app_budget" } });
  expect(runList.records).toHaveLength(1);

  // Audit is append-only through this door on BOTH engines.
  const audit = store.records("vendo_audit");
  await audit.put({
    id: "aud_journey",
    data: {
      id: "aud_journey",
      at: now,
      kind: "tool-call",
      principal: { kind: "user", subject },
      venue: "chat",
      presence: "present",
      tool: "host_send",
    },
  });
  await expect(audit.delete("aud_journey")).rejects.toMatchObject({ code: "blocked" });

  // State enforces the <appId>:<subject> id grammar on BOTH engines.
  const state = store.records("vendo_state");
  await state.put({ id: `app_budget:${subject}`, data: { count: 3 } });
  expect((await state.get(`app_budget:${subject}`))?.data).toEqual({ count: 3 });
  await expect(state.put({ id: "no-grammar", data: {} })).rejects.toMatchObject({ code: "validation" });

  // Blobs: raw bytes round-trip under the app namespace.
  const blobs = store.blobs("app:app_budget:uploads");
  const payload = encoder.encode("receipt bytes");
  await blobs.put("receipts/july.txt", payload, { contentType: "text/plain" });
  const blob = await blobs.get("receipts/july.txt");
  expect(blob?.bytes).toEqual(payload);
  expect(blob?.contentType).toBe("text/plain");
  expect(await blobs.list("receipts/")).toEqual(["receipts/july.txt"]);
}

describe("demo-host journey through the store seam", () => {
  it("passes against hostedStore over the fake console", async () => {
    await demoHostJourney(hosted(fakeConsole()));
  });

  it("passes against the local PGlite engine through the same seam", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-hosted-journey-"));
    const store = createStore({ dataDir });
    try {
      await store.ensureSchema();
      await demoHostJourney(store);
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
