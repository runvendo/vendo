import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_wire" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** The same request arriving from a chosen ORIGIN — i.e. carrying a chosen Host
 *  header, which is how the poisoning attack is expressed. */
function requestFrom(origin: string, method: string, path: string, headers: Record<string, string> = {}): Request {
  const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  return new Request(`${origin}/api/vendo${path}`, {
    method,
    headers: { ...(mutation ? { "content-type": "application/json" } : {}), ...headers },
    ...(mutation ? { body: "{}" } : {}),
  });
}

/**
 * VEGA-INFO-00037 — the learned same-origin base must be taught ONLY by a
 * request that addressed a real Vendo route. Before the fix, `onRequestOrigin`
 * fired for any path under BASE_PATH (a 404 included, first-origin-wins), so an
 * unauthenticated attacker who raced a 404 to a cold-started deployment latched
 * their spoofed Host as the base for every later credential-forwarding call.
 * This is the server-side twin of the present-mode SECURITY pins in
 * server.test.ts.
 */
describe("VEGA-INFO-00037: a 404 must not poison the learned base", () => {
  it("SECURITY: a 404 under BASE_PATH never becomes the learned base, so a later real request from loopback still forwards present credentials", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    const store = await tempStore("vendo-404-poison-");
    const vendo = createVendo({ models: { default: {} as LanguageModel }, principal: async () => principal, store });
    // The stubbed fetch loops the doctor's present-echo route back through the
    // same handler, so it observes exactly what the base resolved to.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input : new Request(input, init);
      return vendo.handler(target);
    }));

    // The attacker's 404 arrives FIRST — this is the whole attack. A 404 must
    // teach the learner NOTHING.
    expect((await vendo.handler(requestFrom("https://attacker.evil", "GET", "/nope-not-a-route"))).status).toBe(404);
    // Only now does a real route from loopback get to teach the base.
    expect((await vendo.handler(requestFrom("http://localhost:3000", "GET", "/status"))).status).toBe(200);

    // Loopback is the trusted dev base, so the present-mode probe forwards the
    // caller's credentials to the deployment's own echo route. Before the fix
    // the attacker's 404 had already fixed an UNTRUSTED base, so the probe would
    // have withheld and this would not be { ok: true }.
    const probe = await vendo.handler(requestFrom("http://localhost:3000", "POST", "/doctor/present", {
      authorization: "Bearer vendo-doctor-present",
      cookie: "vendo_doctor_present=1",
    }));
    expect(await probe.json()).toEqual({ ok: true });
  });
});
