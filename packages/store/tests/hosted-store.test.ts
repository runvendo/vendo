import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  STORE_WIRE_PATHS,
  VendoError,
  engineAppHistory,
  parseStoreWireError,
  storeWireAppDataDeleteFileRequestSchema,
  storeWireAppDataDeleteRequestSchema,
  storeWireAppDataGetFileRequestSchema,
  storeWireAppDataGetRequestSchema,
  storeWireAppDataListFilesRequestSchema,
  storeWireAppDataListRequestSchema,
  storeWireAppDataPutFileRequestSchema,
  storeWireAppDataPutRequestSchema,
  storeWireBlobsDeleteRequestSchema,
  storeWireBlobsGetRequestSchema,
  storeWireBlobsListRequestSchema,
  storeWireBlobsPutRequestSchema,
  storeWireCollectionClaimRequestSchema,
  storeWireCollectionCompareAndSwapRequestSchema,
  storeWireCollectionDeleteRequestSchema,
  storeWireCollectionGetRequestSchema,
  storeWireCollectionInsertIfAbsentRequestSchema,
  storeWireCollectionListRequestSchema,
  storeWireCollectionPutRequestSchema,
  type StoreAdapter,
} from "@vendoai/core";
import { storeAdapterConformance } from "@vendoai/core/conformance";
import { createStore, secretStore, storeSecrets, type VendoStore } from "../src/index.js";
import { hostedStore, hostedStoreOps, type HostedStore } from "../src/hosted-store.js";
import { fakeConsole } from "../src/hosted-store.test-util.js";

const encoder = new TextEncoder();

const hosted = (console_: ReturnType<typeof fakeConsole>) => hostedStore({
  apiKey: "vnd_secret",
  baseUrl: "https://cloud.test",
  fetch: console_.handler as unknown as typeof fetch,
});

describe("hostedStore conformance", () => {
  // The EXISTING StoreAdapter conformance suite (01-core §12 / 02-store §4),
  // run over the full HTTP round-trip against the in-memory console fake.
  //
  // The suite's own collection names are host-flavoured ("conformance_put"),
  // and since the generic records family left the wire there is no door on the
  // hosted mount that takes a name like that: every non-app-scoped collection
  // now rides the engine family, whose allowlist the console enforces. So each
  // case gets its own drawer under the ONE dynamic engine name
  // (`vendo:app-history:<id>`) — the suite's assertions are untouched, the
  // adapter under test is the real façade, and the allowlist stays a real gate
  // instead of one this test asks the fake to drop.
  const engineNamed = (adapter: StoreAdapter): StoreAdapter => ({
    records: (collection) => adapter.records(engineAppHistory(collection)),
    blobs: (namespace) => adapter.blobs(namespace),
    ensureSchema: () => adapter.ensureSchema(),
  });
  const suite = storeAdapterConformance({
    async makeAdapter() {
      return { adapter: engineNamed(hosted(fakeConsole()) as StoreAdapter) };
    },
  });
  for (const c of suite.cases) it(c.name, c.run);
});

describe("hostedStore façade routing — the two homes a collection can have", () => {
  it("an engine collection rides the engine door, over the collection-addressed body", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    const apps = store.records("vendo_apps");

    const doc = { format: "vendo/app@1", id: "app_1", name: "App" };
    await apps.put({ id: "app_1", data: { subject: "user_1", enabled: true, doc } });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/engine/put",
      json: { collection: "vendo_apps", record: { id: "app_1" } },
    });
    expect((await apps.get("app_1"))?.id).toBe("app_1");
    expect(console_.requests[1]).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/get",
      json: { collection: "vendo_apps", id: "app_1" },
    });
  });

  it("an app-scoped collection rides the appData door, with the owner stamped on", async () => {
    const console_ = fakeConsole();
    const store = hostedStore({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      owner: "user_1",
      fetch: console_.handler as unknown as typeof fetch,
    });
    const notes = store.records("app:x:notes");

    const put = await notes.put({ id: "n_1", data: { text: "hi" } });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/app-data/put",
      json: { target: { appId: "x", collection: "notes", owner: "user_1" }, record: { id: "n_1" } },
    });
    // The owner is the RUNTIME's stamp, not something the caller named.
    expect(put.refs).toMatchObject({ subject: "user_1" });
    expect((await notes.get("n_1"))?.data).toEqual({ text: "hi" });
    expect((await notes.list()).records.map((record) => record.id)).toEqual(["n_1"]);

    // Another owner's façade cannot see the row — the appData scoping the
    // generic records door never had.
    const other = hostedStore({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      owner: "user_2",
      fetch: console_.handler as unknown as typeof fetch,
    });
    expect(await other.records("app:x:notes").get("n_1")).toBeNull();

    // appData has no compare-and-set verbs on the wire, so the façade does not
    // pretend to offer them.
    expect(notes.claim).toBeUndefined();
    expect(notes.atomic).toBeUndefined();
  });

  it("a retired /records/* path answers an enveloped 501 naming the op", async () => {
    const console_ = fakeConsole();
    const response = await console_.handler("https://cloud.test/api/v1/store/records/put", {
      method: "POST",
      headers: { authorization: "Bearer vnd_secret", "content-type": "application/json" },
      body: JSON.stringify({ collection: "invoices", record: { id: "inv_1", data: {} } }),
    });
    expect(response.status).toBe(501);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not-implemented");
    expect(body.error.message).toContain("records.put");
    // The client half reads that envelope back as the wire's own refusal.
    expect(parseStoreWireError(response.status, body)).toMatchObject({ code: "not-implemented" });
  });
});

describe("hostedStore wire", () => {
  it("speaks the engine door's wire shapes exactly, with key + deployment identity on every request", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    const runs = store.records("vendo_runs");

    const run = {
      appId: "app_1",
      trigger: { kind: "schedule" },
      status: "ok",
      record: { steps: 1 },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };
    const put = await runs.put({ id: "run_1", data: run });
    expect(put).toMatchObject({ id: "run_1" });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/engine/put",
      contentType: "application/json",
      json: { collection: "vendo_runs", record: { id: "run_1", data: run } },
    });

    expect(await runs.get("run_1")).toEqual(put);
    expect(console_.requests[1]).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/get",
      json: { collection: "vendo_runs", id: "run_1" },
    });
    expect(await runs.get("missing")).toBeNull();

    const listed = await runs.list({ refs: { app_id: "app_1" }, limit: 10 });
    expect(listed.records.map((record) => record.id)).toEqual(["run_1"]);
    expect(console_.requests[3]).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/list",
      json: { collection: "vendo_runs", query: { refs: { app_id: "app_1" }, limit: 10 } },
    });

    // The capability mirror is UNCHANGED by the move onto the engine door:
    // claim is absent on routed reserved collections, atomic rides generic
    // collections and vendo_threads' revision counter only. mcp and knowledge
    // feature-detect on exactly this shape.
    expect(store.records("vendo_apps").claim).toBeUndefined();
    expect(store.records("vendo_threads").atomic).toBeDefined();
    expect(store.records("vendo_apps").atomic).toBeUndefined();
    expect(store.records("vendo_mcp_clients").atomic).toBeUndefined();
    expect(store.records("vendo_mcp_clients").claim).toBeDefined();

    const slots = store.records("vendo_placement_slots");
    await slots.put({ id: "slot_1", data: { holder: null } });
    await expect(slots.claim!({ id: "slot_1", data: { holder: null } }, { data: { holder: "run_1" } }))
      .resolves.toBe(true);
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/claim",
      json: { collection: "vendo_placement_slots", expected: { id: "slot_1", data: { holder: null } } },
    });

    const history = store.records(engineAppHistory("app_1"));
    const inserted = await history.atomic!.insertIfAbsent({ id: "ver_1", data: { version: 1 } });
    expect(inserted?.revision).toBe("1");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/insertIfAbsent",
      json: { collection: "vendo:app-history:app_1", record: { id: "ver_1", data: { version: 1 } } },
    });
    const swapped = await history.atomic!.compareAndSwap({ id: "ver_1", data: { version: 2 } }, "1");
    expect(swapped?.revision).toBe("2");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/compareAndSwap",
      json: { collection: "vendo:app-history:app_1", expectedRevision: "1" },
    });
    await expect(history.atomic!.compareAndSwap({ id: "ver_1", data: { version: 3 } }, "1")).resolves.toBeNull();

    await history.delete("ver_1");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/delete",
      json: { collection: "vendo:app-history:app_1", id: "ver_1" },
    });

    for (const request of console_.requests) {
      expect(request.authorization).toBe("Bearer vnd_secret");
      expect(request.deploymentHost).toEqual(expect.any(String));
      expect(request.deploymentHost).not.toBe("");
      expect(request.deploymentName).toEqual(expect.any(String));
      expect(request.deploymentName).not.toBe("");
    }
  });

  it("a collection the allowlist does not know is refused by the service, not written somewhere", async () => {
    // The one behavior change the removal makes visible at the façade: a host's
    // own collection has no home on the hosted mount any more.
    const store = hosted(fakeConsole());
    await expect(store.records("host_invoices").put({ id: "inv_1", data: {} }))
      .rejects.toMatchObject({ code: "blocked" });
  });

  it("speaks the appData file wire for an app-scoped namespace: base64 JSON, owner-prefixed keys", async () => {
    const console_ = fakeConsole();
    const blobs = hosted(console_).blobs("app:app_x:uploads");

    const bytes = new Uint8Array([0, 1, 2, 255]);
    await blobs.put("images/a b.png", bytes, { contentType: "image/png" });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/app-data/putFile",
      contentType: "application/json",
      json: {
        target: { appId: "app_x", collection: "uploads", owner: "user_local" },
        key: "images/a b.png",
        contentType: "image/png",
      },
    });

    const got = await blobs.get("images/a b.png");
    expect(got).not.toBeNull();
    expect(got!.bytes).toEqual(bytes);
    expect(got!.contentType).toBe("image/png");
    expect(await blobs.get("missing.bin")).toBeNull();

    await blobs.put("docs/readme.txt", encoder.encode("hi"));
    // Keys come back the caller's own — the `<owner>/` leg is the seam's.
    expect(await blobs.list("images/")).toEqual(["images/a b.png"]);
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/app-data/listFiles",
      json: { target: { appId: "app_x", collection: "uploads", owner: "user_local" }, prefix: "images/" },
    });

    await blobs.delete("docs/readme.txt");
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/app-data/deleteFile",
      json: { key: "docs/readme.txt" },
    });
    expect(await blobs.list("")).toEqual(["images/a b.png"]);
  });

  it("a plain blob namespace rides the blobs door, bytes base64 on the body", async () => {
    const console_ = fakeConsole();
    const blobs = hosted(console_).blobs("uploads");
    await blobs.put("a.png", new Uint8Array([7]), { contentType: "image/png" });
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/store/blobs/put",
      json: { namespace: "uploads", key: "a.png", bytes: btoa("\u0007"), contentType: "image/png" },
    });
    expect((await blobs.get("a.png"))?.contentType).toBe("image/png");
    expect(await blobs.list("")).toEqual(["a.png"]);
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
    const cloudFetch = vi.fn<typeof fetch>(async () => Response.json({ record: null }));
    const store = hostedStore({ apiKey: "vnd_secret", fetch: cloudFetch });
    await store.records("vendo_apps").get("x");
    expect(cloudFetch.mock.calls[0]![0]).toBe("https://console.vendo.run/api/v1/store/engine/get");
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
  const adapterFor = (fetchImpl: unknown): HostedStore =>
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

  it("renders the pool meter-exhausted refusal as the crafted dollar sentence", async () => {
    // The console's real 402 body: one meter (`usage`), dollars, one limit.
    const store = adapterFor(respond("meter-exhausted", "meter exhausted", 402, {
      meter: "usage",
      unit: "usd",
      used: 6.2,
      limit: 5,
      resets_at: "2026-08-01T00:00:00.000Z",
      reason: "allowance",
      exits: { upgrade_url: "https://console.vendo.run/billing", byo_docs_url: "https://docs.vendo.run/byo" },
    }));
    await expect(store.records("invoices").put({ id: "r", data: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Vendo Cloud paused usage — the $5.00 included this billing period is used up "
        + "($6.20 of $5.00 used; resets 2026-08-01). "
        + "Upgrade your plan (https://console.vendo.run/billing) "
        + "or bring your own infrastructure (https://docs.vendo.run/byo).",
      detail: { meter: "usage", unit: "usd" },
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

  it("treats only the ENVELOPED not-found as a missing blob; a bare 404 fails loudly", async () => {
    // The console's uniform missing-blob answer → null at the seam.
    const enveloped = vi.fn(async () =>
      Response.json({ error: { code: "not-found", message: "Blob not found." } }, { status: 404 }));
    await expect(adapterFor(enveloped).blobs("files").get("absent.bin")).resolves.toBeNull();
    // A bare 404 (no envelope) is some other server — a misdeployed base URL
    // must not read as an empty blob store forever. Only the ENVELOPED
    // not-found is absence; anything else stays an error, loudly.
    const bare = vi.fn(async () => new Response("<html>not here</html>", { status: 404 }));
    await expect(adapterFor(bare).blobs("files").get("absent.bin"))
      .rejects.toThrow(/failed with 404/);
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
      await store.records("vendo_placement_slots").put({ id: "r", data: {} });
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
      formatVersion: "vendo-genui/v2",
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

// ---------------------------------------------------------------------------
// hostedStoreOps — the 35-op client over `vendo/store-wire@1`.
//
// Unit tests over an injected fake fetch: they pin the route, the request body
// and the response decoding for every op — engine, appData and blobs against the
// EXPORTED store-wire v1 contract, the rest against the console's doors
// (vendo-web apps/console/lib/api/store-handlers.ts + store-doors.ts). A fake
// fetch proves only that the client talks to ITSELF — the real proof is this
// same client run against those handlers over real HTTP, with no mock on
// either side.
// ---------------------------------------------------------------------------

const P = STORE_WIRE_PATHS;

const wireRecord = {
  id: "inv_1",
  data: { total: 5 },
  refs: { owner: "user_a" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: "1",
};

/** The door each named op knocks on. Records and blobs speak the EXPORTED
 * store-wire v1 contract (STORE_WIRE_PATHS, collection/namespace/key on the
 * body, blob bytes base64); transcripts, harness, workspace,
 * lifecycle.promote and /status answer at their STORE_WIRE_PATHS path too;
 * erase keeps the console's own route. `keyed` marks the mutations that carry
 * an Idempotency-Key. */
const DOORS: Record<string, { method: string; path: string; keyed?: true }> = {
  "engine.get": { method: "POST", path: P["engine.get"] },
  "engine.put": { method: "POST", path: P["engine.put"], keyed: true },
  "engine.delete": { method: "POST", path: P["engine.delete"], keyed: true },
  "engine.list": { method: "POST", path: P["engine.list"] },
  "engine.claim": { method: "POST", path: P["engine.claim"], keyed: true },
  "engine.insertIfAbsent": { method: "POST", path: P["engine.insertIfAbsent"], keyed: true },
  "engine.compareAndSwap": { method: "POST", path: P["engine.compareAndSwap"], keyed: true },
  "blobs.put": { method: "POST", path: P["blobs.put"], keyed: true },
  "blobs.get": { method: "POST", path: P["blobs.get"] },
  "blobs.delete": { method: "POST", path: P["blobs.delete"], keyed: true },
  "blobs.list": { method: "POST", path: P["blobs.list"] },
  "appData.put": { method: "POST", path: P["appData.put"], keyed: true },
  "appData.get": { method: "POST", path: P["appData.get"] },
  "appData.list": { method: "POST", path: P["appData.list"] },
  "appData.delete": { method: "POST", path: P["appData.delete"], keyed: true },
  "appData.putFile": { method: "POST", path: P["appData.putFile"], keyed: true },
  "appData.getFile": { method: "POST", path: P["appData.getFile"] },
  "appData.listFiles": { method: "POST", path: P["appData.listFiles"] },
  "appData.deleteFile": { method: "POST", path: P["appData.deleteFile"], keyed: true },
  "transcripts.putThread": { method: "POST", path: P["transcripts.putThread"], keyed: true },
  "transcripts.getThread": { method: "POST", path: P["transcripts.getThread"] },
  "transcripts.listThreads": { method: "POST", path: P["transcripts.listThreads"] },
  "transcripts.deleteThread": { method: "POST", path: P["transcripts.deleteThread"], keyed: true },
  "transcripts.putMessage": { method: "POST", path: P["transcripts.putMessage"], keyed: true },
  "transcripts.recordAnswer": { method: "POST", path: P["transcripts.recordAnswer"], keyed: true },
  "harness.get": { method: "POST", path: P["harness.get"] },
  "harness.set": { method: "POST", path: P["harness.set"], keyed: true },
  "harness.clear": { method: "POST", path: P["harness.clear"], keyed: true },
  "workspace.index": { method: "POST", path: P["workspace.index"] },
  "workspace.read": { method: "POST", path: P["workspace.read"] },
  "workspace.commit": { method: "POST", path: P["workspace.commit"], keyed: true },
  "workspace.history": { method: "POST", path: P["workspace.history"] },
  "lifecycle.erase": { method: "POST", path: "/erase", keyed: true },
  "lifecycle.promote": { method: "POST", path: P["lifecycle.promote"], keyed: true },
  status: { method: "GET", path: P.status },
};

const door = (op: string): string => `${DOORS[op]!.method} ${DOORS[op]!.path}`;

interface WireCall {
  path: string;
  method: string;
  idempotencyKey: string | null;
  body: unknown;
}

/** A mount that answers the canned body for each op's `METHOD path` route and
 * records what the client sent. */
const wireFake = (bodies: Record<string, unknown> = {}) => {
  const calls: WireCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname.slice("/api/v1/store".length)}${parsed.search}`;
    const method = init.method ?? "GET";
    calls.push({
      path,
      method,
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    });
    return Response.json(bodies[`${method} ${path}`] ?? {});
  }) as unknown as typeof fetch;
  return {
    calls,
    ops: hostedStoreOps({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl }),
  };
};

/** One well-formed answer per op, so the whole contract can be driven once. */
const ALL_BODIES: Record<string, unknown> = {
  [door("engine.get")]: { record: wireRecord },
  [door("engine.put")]: { record: wireRecord },
  [door("engine.delete")]: { ok: true },
  [door("engine.list")]: { records: [wireRecord], cursor: "cur_engine" },
  [door("engine.claim")]: { claimed: true },
  [door("engine.insertIfAbsent")]: { record: wireRecord },
  [door("engine.compareAndSwap")]: { record: null },
  [door("blobs.put")]: { ok: true },
  [door("blobs.get")]: { blob: { bytes: btoa("blob bytes"), contentType: "text/plain" } },
  [door("blobs.delete")]: { ok: true },
  [door("blobs.list")]: { keys: ["images/a.png"] },
  [door("appData.put")]: { record: wireRecord },
  [door("appData.get")]: { record: wireRecord },
  [door("appData.list")]: { records: [wireRecord], cursor: "cur_app_data" },
  [door("appData.delete")]: { ok: true },
  [door("appData.putFile")]: { ok: true },
  [door("appData.getFile")]: { blob: { bytes: btoa("file bytes"), contentType: "text/plain" } },
  [door("appData.listFiles")]: { keys: ["receipts/a.pdf"] },
  [door("appData.deleteFile")]: { ok: true },
  [door("transcripts.putThread")]: { record: wireRecord },
  [door("transcripts.getThread")]: { record: wireRecord },
  [door("transcripts.listThreads")]: { records: [wireRecord], cursor: "cur_threads" },
  [door("transcripts.deleteThread")]: { ok: true },
  [door("transcripts.putMessage")]: { record: wireRecord },
  [door("transcripts.recordAnswer")]: { record: wireRecord },
  [door("harness.get")]: { state: { step: 3 } },
  [door("harness.set")]: { ok: true },
  [door("harness.clear")]: { ok: true },
  [door("workspace.index")]: { entries: [{ path: "/a.md" }], cursor: "cur_index" },
  [door("workspace.read")]: { files: { "/a.md": "hi" } },
  [door("workspace.commit")]: { ok: true, commitId: "wsc_1" },
  [door("workspace.history")]: { entries: [{ commitId: "wsc_1" }] },
  [door("lifecycle.erase")]: { report: { vendo_apps: 1 } },
  [door("lifecycle.promote")]: { ok: true },
  [door("status")]: { format: "vendo/store-wire@1", ops: 35 },
};

/** Where an appData op lands: the app, the collection it invented, and the
 * owner the runtime stamped — never a subject the caller names. */
const APP_DATA_TARGET = { appId: "app_1", collection: "invoices", owner: "sub_1" };

/** A real name from the engine allowlist (core's ENGINE_COLLECTIONS) — the gate
 * is server-side, but a made-up name would read as if any name were allowed. */
const ENGINE_COLLECTION = "vendo_workspace_commits";

const driveEveryOp = async (ops: ReturnType<typeof wireFake>["ops"]): Promise<void> => {
  await ops.engine.get(ENGINE_COLLECTION, "wsc_1");
  await ops.engine.put(ENGINE_COLLECTION, { id: "wsc_1", data: { paths: 1 } });
  await ops.engine.delete(ENGINE_COLLECTION, "wsc_1");
  await ops.engine.list(ENGINE_COLLECTION);
  await ops.engine.claim(ENGINE_COLLECTION, { id: "wsc_1", data: { paths: 1 } });
  await ops.engine.insertIfAbsent(ENGINE_COLLECTION, { id: "wsc_2", data: {} });
  await ops.engine.compareAndSwap(ENGINE_COLLECTION, { id: "wsc_2", data: {} }, "1");
  await ops.blobs.put("uploads", "a.png", new Uint8Array([1]));
  await ops.blobs.get("uploads", "a.png");
  await ops.blobs.delete("uploads", "a.png");
  await ops.blobs.list("uploads");
  await ops.appData.put(APP_DATA_TARGET, { id: "inv_1", data: { total: 5 } });
  await ops.appData.get(APP_DATA_TARGET, "inv_1");
  await ops.appData.list(APP_DATA_TARGET);
  await ops.appData.delete(APP_DATA_TARGET, "inv_1");
  await ops.appData.putFile(APP_DATA_TARGET, "receipts/a.pdf", new Uint8Array([1]));
  await ops.appData.getFile(APP_DATA_TARGET, "receipts/a.pdf");
  await ops.appData.listFiles(APP_DATA_TARGET);
  await ops.appData.deleteFile(APP_DATA_TARGET, "receipts/a.pdf");
  await ops.transcripts.putThread({ id: "thr_1", subject: "sub_1", messages: [] });
  await ops.transcripts.getThread("thr_1");
  await ops.transcripts.listThreads();
  await ops.transcripts.deleteThread("thr_1");
  await ops.transcripts.putMessage("thr_1", { role: "user" });
  await ops.transcripts.recordAnswer("thr_1", { text: "done" });
  await ops.harness.get("app_1", "sub_1");
  await ops.harness.set("app_1", "sub_1", { step: 3 });
  await ops.harness.clear("app_1", "sub_1");
  await ops.workspace.index();
  await ops.workspace.read(["/a.md"]);
  await ops.workspace.commit([{ path: "/a.md", data: "hi" }]);
  await ops.workspace.history();
  await ops.lifecycle.erase({ subject: "sub_1" });
  await ops.lifecycle.promote("app_1", "org_1");
  await ops.status();
};

describe("hostedStoreOps — the 35-op wire client", () => {
  it("routes all 35 ops to the console's real door, with a key on exactly the mutations", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);
    await driveEveryOp(ops);

    const expected = Object.values(DOORS);
    expect(calls).toHaveLength(35);
    expect(calls.map((call) => `${call.method} ${call.path}`))
      .toEqual(expected.map((route) => `${route.method} ${route.path}`));
    expect(calls.map((call) => call.idempotencyKey === null ? "read" : "keyed"))
      .toEqual(expected.map((route) => route.keyed === true ? "keyed" : "read"));
    // 20 mutations, 15 reads — and the /status handshake is the one GET with
    // no body at all.
    expect(expected.filter((route) => route.keyed === true)).toHaveLength(20);
    expect(calls.at(-1)).toMatchObject({ path: P.status, method: "GET", body: undefined });
    // Distinct keys across distinct operations (one per logical mutation).
    const keys = calls.map((call) => call.idempotencyKey).filter((key) => key !== null);
    expect(new Set(keys).size).toBe(20);
  });

  it("blobs: JSON POST on the wire door, bytes base64 on the body", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const { calls, ops } = wireFake(ALL_BODIES);

    await ops.blobs.put("uploads", "images/a.png", bytes, { contentType: "image/png" });
    expect(calls[0]).toMatchObject({ method: "POST", path: P["blobs.put"] });
    expect(calls[0]!.body).toEqual({
      namespace: "uploads",
      key: "images/a.png",
      bytes: btoa(String.fromCharCode(0, 1, 2, 255)),
      contentType: "image/png",
    });
    expect(calls[0]!.idempotencyKey).toEqual(expect.stringMatching(/^idm_/));

    expect(await ops.blobs.get("uploads", "images/a.png")).toEqual({
      bytes: encoder.encode("blob bytes"),
      contentType: "text/plain",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: P["blobs.get"],
      body: { namespace: "uploads", key: "images/a.png" },
    });

    await ops.blobs.delete("uploads", "images/a.png");
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: P["blobs.delete"],
      body: { namespace: "uploads", key: "images/a.png" },
    });
    expect(calls[2]!.idempotencyKey).toEqual(expect.stringMatching(/^idm_/));

    expect(await ops.blobs.list("uploads", "images/")).toEqual(["images/a.png"]);
    expect(calls[3]).toMatchObject({
      method: "POST",
      path: P["blobs.list"],
      body: { namespace: "uploads", prefix: "images/" },
    });

    // A missing blob is null at the seam — `{blob: null}` on a 2xx or the
    // ENVELOPED not-found; a bare 404 stays loud (degrades to not-implemented).
    const absent = wireFake({ ...ALL_BODIES, [door("blobs.get")]: { blob: null } });
    expect(await absent.ops.blobs.get("uploads", "gone.png")).toBeNull();
    const envelopedMiss = hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json(
        { error: { code: "not-found", message: "Blob not found." } },
        { status: 404 },
      )) as unknown as typeof fetch,
    });
    expect(await envelopedMiss.blobs.get("uploads", "gone.png")).toBeNull();
    const bare = hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => new Response("<html>nginx</html>", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(bare.blobs.get("uploads", "gone.png")).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("engine and blobs requests validate against the EXPORTED store-wire v1 request schemas", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);
    await ops.engine.get(ENGINE_COLLECTION, "wsc_1");
    await ops.engine.put(ENGINE_COLLECTION, { id: "wsc_1", data: { paths: 1 } });
    await ops.engine.delete(ENGINE_COLLECTION, "wsc_1");
    await ops.engine.list(ENGINE_COLLECTION, { limit: 10 });
    await ops.engine.claim(ENGINE_COLLECTION, { id: "wsc_1", data: { paths: 1 } }, { data: { paths: 2 } });
    await ops.engine.insertIfAbsent(ENGINE_COLLECTION, { id: "wsc_2", data: {} });
    await ops.engine.compareAndSwap(ENGINE_COLLECTION, { id: "wsc_2", data: {} }, "1");
    await ops.blobs.put("uploads", "a.bin", new Uint8Array([7]), { contentType: "application/octet-stream" });
    await ops.blobs.get("uploads", "a.bin");
    await ops.blobs.delete("uploads", "a.bin");
    await ops.blobs.list("uploads", "a");

    const CONTRACT: [keyof typeof P, { safeParse(value: unknown): { success: boolean } }][] = [
      // The collection-addressed body shape, named for its SHAPE rather than
      // for a family — the engine ops are its one door now.
      ["engine.get", storeWireCollectionGetRequestSchema],
      ["engine.put", storeWireCollectionPutRequestSchema],
      ["engine.delete", storeWireCollectionDeleteRequestSchema],
      ["engine.list", storeWireCollectionListRequestSchema],
      ["engine.claim", storeWireCollectionClaimRequestSchema],
      ["engine.insertIfAbsent", storeWireCollectionInsertIfAbsentRequestSchema],
      ["engine.compareAndSwap", storeWireCollectionCompareAndSwapRequestSchema],
      ["blobs.put", storeWireBlobsPutRequestSchema],
      ["blobs.get", storeWireBlobsGetRequestSchema],
      ["blobs.delete", storeWireBlobsDeleteRequestSchema],
      ["blobs.list", storeWireBlobsListRequestSchema],
    ];
    expect(calls).toHaveLength(CONTRACT.length);
    for (const [index, [op, schema]] of CONTRACT.entries()) {
      const call = calls[index]!;
      expect(`${call.method} ${call.path}`).toBe(`POST ${P[op]}`);
      expect(schema.safeParse(call.body).success).toBe(true);
    }
  });

  it("appData requests validate against the EXPORTED store-wire v1 request schemas", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);
    await ops.appData.put(APP_DATA_TARGET, { id: "inv_1", data: { total: 5 } });
    await ops.appData.get(APP_DATA_TARGET, "inv_1");
    await ops.appData.list(APP_DATA_TARGET, { limit: 10 });
    await ops.appData.delete(APP_DATA_TARGET, "inv_1");
    await ops.appData.putFile(APP_DATA_TARGET, "receipts/a.pdf", new Uint8Array([7]), {
      contentType: "application/pdf",
    });
    await ops.appData.getFile(APP_DATA_TARGET, "receipts/a.pdf");
    await ops.appData.listFiles(APP_DATA_TARGET, "receipts/");
    await ops.appData.deleteFile(APP_DATA_TARGET, "receipts/a.pdf");

    const CONTRACT: [keyof typeof P, { safeParse(value: unknown): { success: boolean } }][] = [
      ["appData.put", storeWireAppDataPutRequestSchema],
      ["appData.get", storeWireAppDataGetRequestSchema],
      ["appData.list", storeWireAppDataListRequestSchema],
      ["appData.delete", storeWireAppDataDeleteRequestSchema],
      ["appData.putFile", storeWireAppDataPutFileRequestSchema],
      ["appData.getFile", storeWireAppDataGetFileRequestSchema],
      ["appData.listFiles", storeWireAppDataListFilesRequestSchema],
      ["appData.deleteFile", storeWireAppDataDeleteFileRequestSchema],
    ];
    expect(calls).toHaveLength(CONTRACT.length);
    for (const [index, [op, schema]] of CONTRACT.entries()) {
      const call = calls[index]!;
      expect(`${call.method} ${call.path}`).toBe(`POST ${P[op]}`);
      expect(schema.safeParse(call.body).success, op).toBe(true);
      // The whole address rides ONE target — the owner is the runtime's stamp.
      expect(call.body).toMatchObject({ target: APP_DATA_TARGET });
    }
  });

  it("transcripts: six ops over thread ids and message payloads", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);
    const thread = { id: "thr_1", subject: "sub_1", messages: [{ role: "user" }], title: "Budget" };

    expect(await ops.transcripts.putThread(thread)).toMatchObject({ id: "inv_1" });
    expect(calls[0]!.body).toEqual({ thread });

    expect(await ops.transcripts.getThread("thr_1", { cursor: "cur_1", limit: 50 })).toMatchObject({ id: "inv_1" });
    expect(calls[1]!.body).toEqual({ id: "thr_1", cursor: "cur_1", limit: 50 });

    expect(await ops.transcripts.listThreads({ subject: "sub_1", limit: 25 })).toEqual({
      records: [expect.objectContaining({ id: "inv_1" })],
      cursor: "cur_threads",
    });
    expect(calls[2]!.body).toEqual({ subject: "sub_1", limit: 25 });

    await ops.transcripts.deleteThread("thr_1");
    expect(calls[3]!.body).toEqual({ id: "thr_1" });

    await ops.transcripts.putMessage("thr_1", { role: "assistant", content: "hi" });
    expect(calls[4]!.body).toEqual({ threadId: "thr_1", message: { role: "assistant", content: "hi" } });

    await ops.transcripts.recordAnswer("thr_1", { text: "done" });
    expect(calls[5]!.body).toEqual({ threadId: "thr_1", answer: { text: "done" } });
  });

  it("harness: get/set/clear keyed by app and subject", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);

    expect(await ops.harness.get("app_1", "sub_1")).toEqual({ step: 3 });
    expect(calls[0]!.body).toEqual({ appId: "app_1", subject: "sub_1" });

    await ops.harness.set("app_1", "sub_1", { step: 4 });
    expect(calls[1]!.body).toEqual({ appId: "app_1", subject: "sub_1", state: { step: 4 } });

    await ops.harness.clear("app_1", "sub_1");
    expect(calls[2]!.body).toEqual({ appId: "app_1", subject: "sub_1" });

    // An absent state is null at the seam.
    const absent = wireFake({ [door("harness.get")]: { state: null } });
    expect(await absent.ops.harness.get("app_1", "sub_1")).toBeNull();
  });

  it("workspace: index/read/commit/history, caller-owned commit key", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);

    expect(await ops.workspace.index({ cursor: "cur_0", limit: 100 })).toEqual({
      entries: [{ path: "/a.md" }],
      cursor: "cur_index",
    });
    expect(calls[0]!.body).toEqual({ cursor: "cur_0", limit: 100 });

    expect(await ops.workspace.read(["/a.md"])).toEqual({ "/a.md": "hi" });
    expect(calls[1]!.body).toEqual({ paths: ["/a.md"] });

    await ops.workspace.commit([{ path: "/a.md", data: "hi" }], { idempotencyKey: "idm_caller" });
    expect(calls[2]!.body).toEqual({ entries: [{ path: "/a.md", data: "hi" }] });
    // The caller's key wins — a resumed job replays its own commit.
    expect(calls[2]!.idempotencyKey).toBe("idm_caller");

    expect(await ops.workspace.history()).toEqual({ entries: [{ commitId: "wsc_1" }] });
    expect(calls[3]!.body).toEqual({});
  });

  it("workspace: the path leg of history rides the same door", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);

    await ops.workspace.history({ path: "/a.md", owner: "own_1" });
    expect(calls[0]!.body).toEqual({ path: "/a.md", owner: "own_1" });
  });

  it("lifecycle: erase and promote on their own doors", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);

    // The erase door takes the target FLAT (exactly one of subject/appId).
    expect(await ops.lifecycle.erase({ subject: "sub_1" })).toEqual({ vendo_apps: 1 });
    expect(calls[0]).toMatchObject({ path: "/erase", body: { subject: "sub_1" } });

    await ops.lifecycle.promote("app_1", "org_1");
    expect(calls[1]).toMatchObject({ path: "/lifecycle/promote", body: { appId: "app_1", orgId: "org_1" } });
  });

  it("status: the GET handshake, parsed as vendo/store-wire@1", async () => {
    const { calls, ops } = wireFake(ALL_BODIES);
    expect(await ops.status()).toMatchObject({ format: "vendo/store-wire@1", ops: 35 });
    expect(calls[0]).toMatchObject({ path: "/status", method: "GET" });
    await expect(wireFake({ [door("status")]: { format: "vendo/store-wire@2", ops: 35 } }).ops.status())
      .rejects.toThrow(/invalid status/);
  });

  it("passes cursors through untouched — the server paginates, never the client", async () => {
    const { calls, ops } = wireFake({
      [door("engine.list")]: { records: [], cursor: "opaque||server||cursor" },
      [door("workspace.history")]: { entries: [] },
    });
    expect(await ops.engine.list(ENGINE_COLLECTION, { cursor: "opaque||prev", limit: 1000 })).toEqual({
      records: [],
      cursor: "opaque||server||cursor",
    });
    expect(calls[0]!.body).toEqual({ collection: ENGINE_COLLECTION, query: { cursor: "opaque||prev", limit: 1000 } });
    // No cursor from the server means the page is the last one.
    expect(await ops.workspace.history({ cursor: "opaque||prev" })).toEqual({ entries: [] });
    expect(calls[1]!.body).toEqual({ cursor: "opaque||prev" });
  });

  it("replays the SAME Idempotency-Key on a timeout retry", async () => {
    const seen: (string | null)[] = [];
    let attempts = 0;
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get("idempotency-key"));
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }
      return Response.json({ record: wireRecord });
    }) as unknown as typeof fetch;
    const ops = hostedStoreOps({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl });

    // The write still resolves, and the server's ledger sees ONE logical
    // mutation: the retry replays the key verbatim rather than minting one.
    expect(await ops.engine.put(ENGINE_COLLECTION, { id: "inv_1", data: { total: 5 } })).toMatchObject({ id: "inv_1" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toEqual(expect.stringMatching(/^idm_/));

    // A NEW logical operation mints a new key.
    await ops.engine.put(ENGINE_COLLECTION, { id: "inv_1", data: { total: 6 } });
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("replays the same body on a retry, so the ledger's request hash still matches", async () => {
    const bodies: (string | undefined)[] = [];
    let attempts = 0;
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      bodies.push(typeof init.body === "string" ? init.body : undefined);
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const ops = hostedStoreOps({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl });
    await ops.workspace.commit([{ path: "/a.md", data: "hi" }], { idempotencyKey: "idm_caller" });
    expect(bodies).toEqual([bodies[0], bodies[0]]);
    expect(bodies[0]).toBe(JSON.stringify({ entries: [{ path: "/a.md", data: "hi" }] }));
  });

  it("does not retry a non-timeout failure — a refusal is an answer", async () => {
    let attempts = 0;
    const ops = hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => {
        attempts += 1;
        return Response.json({ error: { code: "conflict", message: "taken" } }, { status: 409 });
      }) as unknown as typeof fetch,
    });
    await expect(ops.engine.put(ENGINE_COLLECTION, { id: "inv_1", data: {} }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(attempts).toBe(1);
  });

  it("maps an enveloped error to its VendoError code through parseStoreWireError", async () => {
    const enveloped = (code: string, message: string, status: number) => hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json({ error: { code, message } }, { status })) as unknown as typeof fetch,
    });
    await expect(enveloped("conflict", "belongs to another subject", 409)
      .engine.put("vendo_threads", { id: "thr_1", data: {} }))
      .rejects.toMatchObject({ code: "conflict", message: "belongs to another subject" });
    await expect(enveloped("blocked", "vendo_audit is append-only", 403)
      .engine.delete("vendo_audit", "aud_1"))
      .rejects.toMatchObject({ code: "blocked", message: "vendo_audit is append-only" });
    // The idempotency ledger's own refusal — same key, different body — is a
    // conflict the caller must see, never a swallowed replay.
    await expect(enveloped("conflict", "Idempotency-Key was already used with a different request body.", 409)
      .workspace.commit([{ path: "/a.md", data: "hi" }], { idempotencyKey: "idm_caller" }))
      .rejects.toMatchObject({ code: "conflict" });
    // An enveloped not-found stays not-found; a BARE 404 is a mount failure
    // and degrades to not-implemented rather than reading as absence.
    await expect(enveloped("not-found", "unknown record", 404).engine.get(ENGINE_COLLECTION, "r"))
      .rejects.toMatchObject({ code: "not-found" });
    const bare = hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => new Response("<html>nginx</html>", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(bare.engine.get(ENGINE_COLLECTION, "r")).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("reads a BARE 401/402 as cloud-required, never as an unsupported op — an envelope still wins", async () => {
    const refusing = (body: unknown, status: number) => hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json(body, { status })) as unknown as typeof fetch,
    });
    // A revoked key used to reach the caller as a not-implemented relabelled
    // "Vendo Cloud store does not support the ... operation" (#1203) — the
    // skew story told for a key problem. It says what the console said now,
    // and the relabel below never fires for it.
    const revoked = await refusing({ error: { code: "unauthorized", message: "Valid API key required." } }, 401)
      .engine.get(ENGINE_COLLECTION, "r")
      .then(() => undefined, (reason: unknown) => reason);
    expect(revoked).toMatchObject({ code: "cloud-required", message: "Valid API key required." });
    expect((revoked as VendoError).message).not.toContain("does not support the");
    // A dry meter carries the crafted sentence plus its structured fields.
    await expect(refusing({
      error: { code: "meter-exhausted", message: "meter exhausted" },
      meter: "usage",
      unit: "usd",
      used: 6.2,
      limit: 5,
    }, 402).engine.get(ENGINE_COLLECTION, "r")).rejects.toMatchObject({
      code: "cloud-required",
      message: expect.stringContaining("Vendo Cloud paused usage"),
      detail: { meter: "usage", unit: "usd" },
    });
    // Neither refusal is wire-legal (`unauthorized` and `meter-exhausted` are
    // not VendoError codes), which is exactly what makes them the console's.
    // A 401/402 that DOES carry a recognized envelope is the service's own
    // protocol answer and keeps it — reading it as a key or billing problem
    // would tell the caller a story its mount never told.
    await expect(refusing({ error: { code: "blocked", message: "vendo_audit is append-only" } }, 401)
      .engine.delete("vendo_audit", "aud_1"))
      .rejects.toMatchObject({ code: "blocked", message: "vendo_audit is append-only" });
    await expect(refusing({ error: { code: "conflict", message: "revision moved on" } }, 402)
      .engine.compareAndSwap(ENGINE_COLLECTION, { id: "r", data: {} }, "rev_1"))
      .rejects.toMatchObject({ code: "conflict", message: "revision moved on" });
  });

  it("surfaces an unsupported op cleanly, naming it — never a silent fallback", async () => {
    // `Response`'s own body parameter rather than DOM's `BodyInit`: this
    // package compiles against ES2022 + @types/node, with no DOM lib.
    const notImplemented = (body: ConstructorParameters<typeof Response>[0]) => hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => new Response(body, {
        status: 501,
        ...(body === null ? {} : { headers: { "content-type": "application/json" } }),
      })) as unknown as typeof fetch,
    });
    // The console's catch-all answers the ENVELOPED not-implemented 501 for
    // any op its mount does not serve (app/api/v1/store/[...op]/route.ts).
    const enveloped = notImplemented(JSON.stringify({
      error: { code: "not-implemented", message: "Unknown store operation: workspace/commit." },
    }));
    // "Unknown store operation" is the console's version-skew tell (#1251):
    // the message must say the real cause — an outdated client — not read as
    // an outage or a capability gap.
    await expect(enveloped.workspace.commit([{ path: "/a.md", data: "hi" }])).rejects.toMatchObject({
      code: "not-implemented",
      message: 'Vendo Cloud store does not support the "workspace.commit" operation — Unknown store operation: workspace/commit.'
        + " The console no longer serves this operation, which usually means this @vendoai/vendo is older than the console — update the package to restore Cloud persistence.",
    });
    // A bare 501 (no envelope) names the op just the same.
    await expect(notImplemented(null).lifecycle.promote("app_1", "org_1")).rejects.toMatchObject({
      code: "not-implemented",
      message: expect.stringContaining('does not support the "lifecycle.promote" operation'),
    });
    // Every family names its own op — no silent partial execution anywhere.
    await expect(notImplemented(null).transcripts.recordAnswer("thr_1", { text: "x" })).rejects.toMatchObject({
      code: "not-implemented",
      message: expect.stringContaining('"transcripts.recordAnswer"'),
    });
    await expect(notImplemented(null).blobs.put("uploads", "a.png", new Uint8Array([1]))).rejects.toMatchObject({
      code: "not-implemented",
      message: expect.stringContaining('"blobs.put"'),
    });
  });

  it("treats a malformed 2xx as service misbehavior, never the caller's fault", async () => {
    const answering = (body: unknown) => hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json(body)) as unknown as typeof fetch,
    });
    await expect(answering({}).engine.get(ENGINE_COLLECTION, "r")).rejects.toThrow(/invalid record/);
    await expect(answering({ records: "nope" }).engine.list(ENGINE_COLLECTION)).rejects.toThrow(/invalid list/);
    await expect(answering({ claimed: "yes" }).engine.claim(ENGINE_COLLECTION, { id: "r", data: {} }))
      .rejects.toThrow(/invalid claim/);
    await expect(answering({ keys: [1] }).blobs.list("uploads")).rejects.toThrow(/invalid blob list/);
    await expect(answering({ blob: {} }).blobs.get("uploads", "a.png")).rejects.toThrow(/invalid blob/);
    await expect(answering({}).harness.get("app_1", "sub_1")).rejects.toThrow(/invalid harness state/);
    await expect(answering({}).workspace.index()).rejects.toThrow(/invalid entries/);
    await expect(answering({ files: [] }).workspace.read(["/a.md"])).rejects.toThrow(/invalid workspace read/);
    await expect(answering({}).lifecycle.erase({ subject: "s" })).rejects.toThrow(/invalid report/);
  });
});

describe("hostedStore keeps its StoreAdapter surface and gains the op surface", () => {
  it("carries records/blobs/erase unchanged, plus ops on the same doors", async () => {
    const console_ = fakeConsole();
    const store = hosted(console_);
    expect(typeof store.records).toBe("function");
    expect(typeof store.blobs).toBe("function");
    expect(typeof store.erase.bySubject).toBe("function");
    // Eight families — the generic records family is gone from the op surface.
    expect(Object.keys(store.ops).sort()).toEqual([
      "appData", "blobs", "engine", "harness", "lifecycle", "status", "transcripts", "workspace",
    ]);

    // The op surface rides the SAME mount, key and identity headers as the
    // StoreAdapter surface, over the same wire doors — a record written through
    // one is readable through the other, which is what "one home, two
    // surfaces" has to mean.
    await store.ops.engine.put(ENGINE_COLLECTION, { id: "wsc_1", data: { paths: 1 } });
    expect(console_.requests.at(-1)).toMatchObject({
      url: "https://cloud.test/api/v1/store/engine/put",
      authorization: "Bearer vnd_secret",
    });
    expect(await store.records(ENGINE_COLLECTION).get("wsc_1")).toMatchObject({ id: "wsc_1", data: { paths: 1 } });
    await store.ops.engine.delete(ENGINE_COLLECTION, "wsc_1");
    expect(await store.ops.engine.get(ENGINE_COLLECTION, "wsc_1")).toBeNull();

    // Blobs too, on the one door both surfaces now share.
    await store.ops.blobs.put("uploads", "images/a.png", new Uint8Array([7]), { contentType: "image/png" });
    expect(await store.blobs("uploads").get("images/a.png")).toMatchObject({ contentType: "image/png" });
    expect(await store.ops.blobs.list("uploads", "images/")).toEqual(["images/a.png"]);
  });

  // 16 of the 35 ops have no door in the fake: all 6 transcripts, all 3
  // harness, all 4 workspace, lifecycle.promote and /status. It used to answer
  // them with a `not-found` envelope — the SAME answer a live console sends
  // when it refuses — so a test exercising one of those families read a
  // plausible rejection and asserted nothing. The fake now throws out of
  // `fetch`, which no console answer can be mistaken for.
  it("never stands in for a door it does not serve", async () => {
    const store = hosted(fakeConsole());
    const unserved: Array<[string, () => Promise<unknown>]> = [
      ["transcripts", () => store.ops.transcripts.listThreads()],
      ["harness", () => store.ops.harness.get("app_1", "sub_1")],
      ["workspace", () => store.ops.workspace.index()],
      ["lifecycle.promote", () => store.ops.lifecycle.promote("app_1", "org_1")],
      ["status", () => store.ops.status()],
    ];
    for (const [family, call] of unserved) {
      const error = await call().then(() => undefined, (reason: unknown) => reason);
      expect(error, family).toBeInstanceOf(Error);
      expect((error as Error).name, family).toBe("FakeConsoleUnservedRoute");
      // Not a VendoError: a wire-legal code would be the console's own voice.
      expect(error, family).not.toBeInstanceOf(VendoError);
    }
  });
});
