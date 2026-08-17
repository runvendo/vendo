/**
 * POST /api/vendo/tick — the ONE wake endpoint, and the only door that can
 * start unattended work. Three wakers knock on it and none of them holds a
 * schedule: the host's own cron and the dev ticker present the bearer, Vendo
 * Cloud's heartbeat presents a standard-webhooks signature over an empty body.
 * The engine decides what is due, so the door's whole job is to prove who is
 * knocking and report what fired.
 *
 * The signed leg signs against the SHIPPED verifier
 * (packages/automations/src/webhook-signature.ts) rather than against a scheme
 * restated here. Cloud's own door originally keyed the HMAC on the secret's
 * characters, agreed with its own restatement, and would have answered 401 to
 * every knock in the fleet forever; a test that restates the scheme cannot tell
 * that apart from a working door.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The SHIPPED verifier, the same one the door itself calls — so this test signs
// against the very code Cloud verified against, never a scheme restated here.
import {
  automationsInternals,
  base64url,
  signedWebhookBytes,
  verifySignature,
} from "@vendoai/automations";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_AUTOMATION_OWNER } from "../src/compose-automations.js";
import { createVendo, type Vendo } from "../src/server.js";
import { deriveTickSecret } from "../src/tick-enrolment.js";
import { systemRoutes } from "../src/wire/misc.js";

/** A tick secret exactly as Cloud mints one: 32 random BYTES, carried as
 *  base64url text through the SHIPPED encoder. The test keeps the bytes, so it
 *  signs with them and never restates the decode the door owes. */
const { secret: SECRET, keyBytes: KEY_BYTES } = (() => {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  return { secret: base64url(keyBytes), keyBytes };
})();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const model = {} as LanguageModel;
const ownerCtx = {
  principal: CODE_AUTOMATION_OWNER,
  venue: "automation",
  presence: "away",
  sessionId: "session_tick_door_test",
} as const;

async function setup(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-tick-door-"));
  const store = createStore({ dataDir });
  const vendo = createVendo({ models: { default: model }, principal: async () => null, store });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  // The boot reconcile and the schema both ride the ready() latch.
  await vendo.handler(new Request("https://host.test/api/vendo/status"));
  return { vendo, store };
}

/** Arm a record and back-date its schedule cursor so the very next tick finds it
 *  due. `create` initializes the cursor to now precisely so a fresh deployment
 *  does not fire everything at once, which is why the cursor is seeded here. */
async function armDue(
  vendo: Vendo,
  store: VendoStore,
  id: string,
  extra: { task: Parameters<ReturnType<typeof automationsInternals>["create"]>[0]["task"]; agent?: string },
): Promise<void> {
  const { create } = automationsInternals(vendo.automations);
  await create({
    id,
    owner: CODE_AUTOMATION_OWNER,
    when: { every: "15m" },
    authoredBy: "code",
    ...extra,
  }, ownerCtx);
  await store.records("automations:schedule").put({ id, data: { lastFiredAt: "2026-07-12T08:00:00.000Z" } });
}

const tick = (headers: Record<string, string>): Request =>
  new Request("https://host.test/api/vendo/tick", { method: "POST", headers });

const bearer = { authorization: `Bearer ${SECRET}` };

/** Exactly what Cloud's heartbeat sends, signed with the secret's BYTES. */
async function signed(
  keyBytes: Uint8Array<ArrayBuffer>,
  seconds = Math.floor(Date.now() / 1_000),
): Promise<{ headers: Record<string, string>; signature: string; signed: Uint8Array<ArrayBuffer> }> {
  const id = "msg_heartbeat_1";
  const timestamp = String(seconds);
  // Copied into a fresh view because the shipped signature is declared over the
  // unparameterized `Uint8Array`, which WebCrypto's BufferSource will not take.
  const body = new Uint8Array(signedWebhookBytes(id, timestamp, new Uint8Array()));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, body);
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return {
    headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
    signature,
    signed: body,
  };
}

const otherKeyBytes = (): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
};

describe("the firing door's two credentials, side by side", () => {
  it("answers 202 { fired: n } to the host's own bearer, and a duplicate knock claims NOTHING", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo, store } = await setup();
    await armDue(vendo, store, "atm_due_a", { task: { kind: "steps", steps: [] } });
    await armDue(vendo, store, "atm_due_b", { task: { kind: "steps", steps: [] } });

    const first = await vendo.handler(tick(bearer));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ fired: 2 });

    // Idempotent, and not because anything here says so: the engine's cursor
    // claim is atomic, so the second knock finds nothing left to claim and says
    // so honestly rather than inventing a run to look busy.
    const duplicate = await vendo.handler(tick(bearer));
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ fired: 0 });
  });

  it("answers 202 to Cloud's signed heartbeat, over the same secret", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo } = await setup();
    const heartbeat = await signed(KEY_BYTES);

    // ORACLE — the artifact Cloud signed against says this delivery is good. If
    // the signing above were wrong, this fails HERE rather than quietly agreeing
    // with a door that is wrong the same way.
    expect(await verifySignature(SECRET, heartbeat.signature, heartbeat.signed)).toBe(true);

    const response = await vendo.handler(tick(heartbeat.headers));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ fired: 0 });
  });

  it("refuses a request carrying neither credential, naming both", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo } = await setup();
    const fired = vi.spyOn(vendo.automations, "tick");

    const response = await vendo.handler(tick({}));

    expect(response.status).toBe(401);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("blocked");
    expect(body.error.message).toContain("VENDO_TICK_SECRET");
    expect(body.error.message).toContain("webhook-signature");
    expect(fired).not.toHaveBeenCalled();
  });

  it("refuses a signature minted under another secret, and a stale one under the right secret", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo } = await setup();

    expect((await vendo.handler(tick((await signed(otherKeyBytes())).headers))).status).toBe(401);
    // Outside the ±300s window: a captured signature is not a permanent key.
    const stale = Math.floor(Date.now() / 1_000) - 600;
    expect((await vendo.handler(tick((await signed(KEY_BYTES, stale)).headers))).status).toBe(401);
  });

  it("refuses everything when the deployment set no secret at all", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", undefined);
    const { vendo } = await setup();

    expect((await vendo.handler(tick({ authorization: "Bearer " }))).status).toBe(401);
    expect((await vendo.handler(tick((await signed(KEY_BYTES)).headers))).status).toBe(401);
  });
});

/** A Cloud deployment configures NOTHING: the secret Cloud signs with is derived
 *  from the VENDO_API_KEY the deployment already has, and enrolment publishes it.
 *  So the door has to accept that derived value — and must still let an operator
 *  who set VENDO_TICK_SECRET keep it (hard BYO rule). */
describe("the Cloud deployment nobody configured a tick secret on", () => {
  const CLOUD_KEY = `vnd_${"a".repeat(40)}`;
  const decoded = (secret: string): Uint8Array<ArrayBuffer> =>
    new Uint8Array(Buffer.from(secret, "base64url"));

  it("answers 202 to a heartbeat signed with the secret DERIVED from VENDO_API_KEY", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", undefined);
    vi.stubEnv("VENDO_API_KEY", CLOUD_KEY);
    // Booting a Cloud deployment enrols it, and this one has no VENDO_BASE_URL to
    // publish — so the shout IS the enrolment wiring, live, at the ready() latch.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { vendo } = await setup();
    const derived = await deriveTickSecret(CLOUD_KEY);
    const heartbeat = await signed(decoded(derived));

    // ORACLE — the shipped verifier says a knock keyed on this secret's decoded
    // bytes is good, so a 401 below would be the DOOR's fault, not the signer's.
    expect(await verifySignature(derived, heartbeat.signature, heartbeat.signed)).toBe(true);

    expect((await vendo.handler(tick(heartbeat.headers))).status).toBe(202);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("VENDO_BASE_URL"));
  });

  it("still lets VENDO_TICK_SECRET win when the operator set one", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    vi.stubEnv("VENDO_API_KEY", CLOUD_KEY);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { vendo } = await setup();

    expect((await vendo.handler(tick(bearer))).status).toBe(202);
    // And the derived value is not a SECOND key into the door: the override wins
    // outright, so what enrolment published is the one secret Cloud may knock with.
    const derived = await deriveTickSecret(CLOUD_KEY);
    expect((await vendo.handler(tick((await signed(decoded(derived))).headers))).status).toBe(401);
  });
});

describe("a goal whose agent name nobody registered", () => {
  it("writes a LOUD failed run row and never falls back to another brain", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo, store } = await setup();
    await armDue(vendo, store, "atm_ghost", {
      task: { kind: "goal", prompt: "file the weekly report" },
      agent: "nobody",
    });

    const response = await vendo.handler(tick(bearer));
    expect(await response.json()).toEqual({ fired: 1 });

    // The miss is in the ONE ledger, where the owner is already looking — not a
    // log line, and not a silent skip. Running someone's automation through a
    // brain they did not name would be worse than not running it, because the
    // wrong agent would act with the owner's grants and nobody would find out.
    const { runs } = await vendo.automations.runs.list({ automationId: "atm_ghost" }, ownerCtx);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "error",
      error: { code: "not-found", message: 'no agent named "nobody" is registered' },
    });
    // "nothing ran" — the row says so in the summary the owner reads, and the
    // deployment's own composed brain (registered under the default name) is
    // NOT what answered.
    expect(runs[0]?.summary).toContain("nothing ran");
    expect(runs[0]?.steps).toEqual([]);
  });
});

describe("the automations leg", () => {
  it("answers 503 when the tick itself fails, so a retrying cron comes back", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const { vendo } = await setup();
    vi.spyOn(vendo.automations, "tick").mockRejectedValue(new Error("store unreachable"));

    const response = await vendo.handler(tick(bearer));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable", message: expect.stringContaining("store unreachable") },
    });
  });
});

/** The hosted TTL sweep rides this tick because a serverless deployment has no
 *  other cadence — but it is HOUSEKEEPING, and it used to 500 the whole call,
 *  which told a heartbeat the deployment was down when its automations had just
 *  run fine. Driven at the route, because `sweep()` rejecting is the seam. */
describe("the sweep leg cannot change the automations answer", () => {
  it("still reports what fired, and tells the operator the sweep failed", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", SECRET);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const entry = systemRoutes.find((candidate) => candidate.pattern.kind === "exact"
      && candidate.pattern.path === "/tick")!;

    const response = await entry.handler({
      request: tick(bearer),
      sweep: async () => { throw new Error("sweep boom"); },
      deps: {
        sweepOnTick: true,
        automations: { tick: async () => ["run_1"] },
      },
    } as unknown as Parameters<typeof entry.handler>[0]);

    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ fired: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sweep boom"));
  });
});
