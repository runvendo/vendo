import { VendoError, type Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createContextResolver } from "./context.js";
import type { WireDeps } from "./shared.js";

/** #872 — a throwing principal resolver must surface its own actionable
    message (the presets write those to be shown), not vanish into the
    catch-all's "Internal Vendo error". */

const request = (): Request => new Request("https://host.test/api/vendo/connections");

const depsFor = (principal: () => Promise<Principal | null>): WireDeps => ({
  principal,
  trustedBaseIsHttps: false,
  sessionId: "sess_wire",
  sessions: { ttlMs: 1000, sweepIntervalMs: 1000, now: () => 0 },
  sessionStore: {
    async register() { /* no registry needed for these cases */ },
    async adopt() { return null; },
  },
} as unknown as WireDeps);

describe("#872 — principal-resolver failures are named", () => {
  it("wraps a thrown Error into a VendoError carrying the resolver's message", async () => {
    const resolve = createContextResolver(
      depsFor(async () => {
        throw new Error("authJs() has no session secret: set AUTH_SECRET or pass authJs({ secret }).");
      }),
      {},
    );
    const failure = await resolve(request(), "chat").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(VendoError);
    expect((failure as VendoError).message).toContain("principal resolution failed");
    expect((failure as VendoError).message).toContain("authJs() has no session secret");
  });

  it("passes a resolver-thrown VendoError through unchanged", async () => {
    const original = new VendoError("blocked", "the host says no");
    const resolve = createContextResolver(
      depsFor(async () => {
        throw original;
      }),
      {},
    );
    await expect(resolve(request(), "chat")).rejects.toBe(original);
  });

  it("non-Error throws still produce a named VendoError", async () => {
    const resolve = createContextResolver(
      depsFor(async () => {
        throw "string failure"; // eslint-disable-line no-throw-literal -- the point of the case
      }),
      {},
    );
    await expect(resolve(request(), "chat")).rejects.toThrow(/principal resolution failed: string failure/);
  });
});
