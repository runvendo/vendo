import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import { createAppTokens, type SandboxAdapter, type SandboxMachine } from "@vendoai/apps";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const ADA: Principal = { kind: "user", subject: "user_ada" };

const decoder = new TextDecoder();

/** Minimal box: every machine dispatches requests to the given handler. */
interface BoxHttp {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
type BoxHandler = (request: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}) => Promise<BoxHttp> | BoxHttp;

function boxSandbox(handler: BoxHandler): SandboxAdapter {
  const machine: SandboxMachine = {
    id: "fake_box",
    async request(request) {
      const answer = await handler(request);
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        body: new TextEncoder().encode(answer.body ?? ""),
      };
    },
    async url(port?: number) { return `https://${port ?? 8080}-fake_box.wire.test`; },
    async snapshot() { return "fake:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

const doc = (id = "app_skin"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Skin app",
});

interface Skin {
  vendo: Vendo;
  store: VendoStore;
  token: string;
}

async function setup(handler: BoxHandler = () => ({ status: 200 })): Promise<Skin> {
  // The machine-env assembler composes the box's callback doors from the
  // operator-set public origin, so provisioning requires it.
  vi.stubEnv("VENDO_BASE_URL", "http://wire.test");
  const store = await tempStore("vendo-box-wire-");
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: "app_skin",
    data: { subject: ADA.subject, enabled: false, doc: doc() },
    refs: { subject: ADA.subject },
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async (req) => {
      const subject = req.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    sandbox: boxSandbox(handler),
    // Wave 9 — machine provisioning is flag-gated.
    apps: { experimentalMachines: true },
  });
  // Provision (Lane B's graduation step) so the fn door has a machine to wake;
  // it mints the app's bearer, which the test rotates to hold a known one.
  await vendo.apps.machine.provision("app_skin", {
    principal: ADA,
    venue: "app",
    presence: "present",
    sessionId: "session_box_wire",
  });
  const token = await createAppTokens(store).mint("app_skin", ADA.subject);
  return { vendo, store, token };
}

function wireRequest(path: string, init: RequestInit = {}, subject?: string): Request {
  const headers = new Headers(init.headers);
  if (subject !== undefined) headers.set("x-test-user", subject);
  return new Request(`http://wire.test/api/vendo${path}`, { ...init, headers });
}

describe("POST /apps/:appId/fn/:name (the fn proxy across the skin)", () => {
  it("forwards to the box's POST /fn/<name> and relays status/body/content-type", async () => {
    const seen: Array<{ method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | string }> = [];
    const { vendo } = await setup((request) => {
      seen.push(request);
      return { status: 201, headers: { "content-type": "application/json", "set-cookie": "evil=1" }, body: JSON.stringify({ ok: true }) };
    });
    const response = await vendo.handler(wireRequest("/apps/app_skin/fn/chaseInvoices", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "host_session=s3cret", authorization: "Bearer host" },
      body: JSON.stringify({ invoice: "inv_1" }),
    }, ADA.subject));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-type")).toContain("application/json");
    // Host response hygiene: nothing but content-type relays out of the box.
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/fn/chaseInvoices" });
    // Request hygiene: the box never sees host credentials.
    const forwarded = seen[0]!.headers ?? {};
    expect(Object.keys(forwarded)).toEqual(["content-type"]);
    expect(decoder.decode(seen[0]!.body as Uint8Array)).toBe(JSON.stringify({ invoice: "inv_1" }));
  });

  it("is principal-scoped: a non-owner gets 404 and the box is never woken", async () => {
    let calls = 0;
    const { vendo } = await setup(() => {
      calls += 1;
      return { status: 200 };
    });
    const response = await vendo.handler(wireRequest("/apps/app_skin/fn/hello", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, "user_bob"));
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  it("rejects an invalid fn name before touching anything", async () => {
    const { vendo } = await setup();
    const response = await vendo.handler(wireRequest("/apps/app_skin/fn/bad%20name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, ADA.subject));
    expect(response.status).toBe(400);
  });

  it("answers 504 when the box exceeds the fn timeout", async () => {
    vi.useFakeTimers();
    const { vendo } = await setup(() => new Promise<never>(() => { /* hang forever */ }));
    const pending = vendo.handler(wireRequest("/apps/app_skin/fn/slow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, ADA.subject));
    await vi.advanceTimersByTimeAsync(31_000);
    const response = await pending;
    expect(response.status).toBe(504);
  });
});

describe("the /box callback surface (app-token bearer)", () => {
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  it("rows: PUT, GET, LIST, DELETE round-trip, scoped to the app's own namespace", async () => {
    const { vendo, store, token } = await setup();

    const put = await vendo.handler(wireRequest("/box/rows/notes/note_1", {
      method: "PUT",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ data: { text: "chase inv_1" } }),
    }));
    expect(put.status).toBe(200);

    const get = await vendo.handler(wireRequest("/box/rows/notes/note_1", { headers: bearer(token) }));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: "note_1", data: { text: "chase inv_1" } });

    const list = await vendo.handler(wireRequest("/box/rows/notes", { headers: bearer(token) }));
    expect(list.status).toBe(200);
    expect((await list.json() as { records: unknown[] }).records).toHaveLength(1);

    // The row landed in the app-scoped store collection, nowhere else.
    const scoped = await store.records("app:app_skin:box:notes").get("note_1");
    expect(scoped).not.toBeNull();

    const remove = await vendo.handler(wireRequest("/box/rows/notes/note_1", {
      method: "DELETE",
      headers: bearer(token),
    }));
    expect(remove.status).toBe(200);
    expect(await store.records("app:app_skin:box:notes").get("note_1")).toBeNull();
  });

  it("refuses a missing, malformed, or unknown bearer with 401", async () => {
    const { vendo } = await setup();
    for (const headers of [{}, bearer("vat_" + "0".repeat(64)), { authorization: "Basic nope" }]) {
      const response = await vendo.handler(wireRequest("/box/rows/notes", { headers }));
      expect(response.status).toBe(401);
    }
  });

  it("rejects an oversized row body", async () => {
    const { vendo, token } = await setup();
    const response = await vendo.handler(wireRequest("/box/rows/notes/big", {
      method: "PUT",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ data: { blob: "x".repeat(300 * 1024) } }),
    }));
    expect(response.status).toBe(400);
  });

  it("tools: relays the guard-bound outcome as the app's owner", async () => {
    const { vendo, token } = await setup();
    const response = await vendo.handler(wireRequest("/box/tools/host_missing_tool", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));
    expect(response.status).toBe(200);
    // No such tool in this composition — the registry's honest error outcome
    // relays verbatim; the pipe (auth → ctx → guard-bound execute) is what
    // this asserts. Approval flows are covered by the integration gate.
    expect(await response.json()).toMatchObject({ status: "error" });
  });

  it("tools: requires an args object", async () => {
    const { vendo, token } = await setup();
    const response = await vendo.handler(wireRequest("/box/tools/host_anything", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(400);
  });
});

describe("the Lane E redaction guard on the box seams", () => {
  const STRIPE_VALUE = "vendo_fixture_4eC39HqLyjWDarjtT1zdp7dc";
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  /** Like setup(), but the app declares a secret and the host has its value. */
  async function secretSetup(handler: BoxHandler): Promise<Skin> {
    vi.stubEnv("VENDO_BASE_URL", "http://wire.test");
    const store = await tempStore("vendo-box-redact-");
    await store.ensureSchema();
    await store.records("vendo_apps").put({
      id: "app_skin",
      data: { subject: ADA.subject, enabled: false, doc: { ...doc(), secrets: ["STRIPE_KEY"] } },
      refs: { subject: ADA.subject },
    });
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async (req) => {
        const subject = req.headers.get("x-test-user");
        return subject === null ? null : { kind: "user", subject };
      },
      store,
      sandbox: boxSandbox(handler),
      secrets: { get: async (name) => (name === "STRIPE_KEY" ? STRIPE_VALUE : undefined) },
      // Wave 9 — machine provisioning is flag-gated.
      apps: { experimentalMachines: true },
    });
    await vendo.apps.machine.provision("app_skin", {
      principal: ADA,
      venue: "app",
      presence: "present",
      sessionId: "session_box_redact",
    });
    const token = await createAppTokens(store).mint("app_skin", ADA.subject);
    return { vendo, store, token };
  }

  it("an fn response echoing the secret value relays redacted", async () => {
    const { vendo } = await secretSetup(() => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `charged via ${STRIPE_VALUE}`,
    }));
    const response = await vendo.handler(wireRequest("/apps/app_skin/fn/charge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, ADA.subject));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("charged via [redacted:STRIPE_KEY]");
  });

  it("a row PUT carrying the secret value is scrubbed BEFORE it lands in the store", async () => {
    const { vendo, store, token } = await secretSetup(() => ({ status: 200 }));
    const put = await vendo.handler(wireRequest("/box/rows/notes/note_1", {
      method: "PUT",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ data: { memo: `key is ${STRIPE_VALUE}` } }),
    }));
    expect(put.status).toBe(200);
    // The response is scrubbed…
    expect(JSON.stringify(await put.json())).not.toContain(STRIPE_VALUE);
    // …and so is the persisted row itself (the store never holds the value).
    const record = await store.records("app:app_skin:box:notes").get("note_1");
    expect(JSON.stringify(record)).not.toContain(STRIPE_VALUE);
    expect((record?.data as { memo: string }).memo).toBe("key is [redacted:STRIPE_KEY]");
  });
});
