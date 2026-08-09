import { VendoError, type Membership, type Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createContextResolver } from "../../src/wire/context.js";
import type { WireDeps } from "../../src/wire/shared.js";

/** Build contract §9.1 — the wire resolves memberships ONCE per request and
    stashes them on the ctx; the `kind:"org"` principal refusal stays. */

const request = (): Request => new Request("https://host.test/api/vendo/apps");

const depsFor = (over: {
  principal: Principal | null;
  memberships?: (principal: Principal) => Promise<Membership[]>;
}): WireDeps => ({
  principal: async () => over.principal,
  ...(over.memberships === undefined ? {} : { memberships: over.memberships }),
  trustedBaseIsHttps: false,
  sessionId: "sess_wire",
  sessions: { ttlMs: 1000, sweepIntervalMs: 1000, now: () => 0 },
  sessionStore: {
    async register() { /* no registry needed for these cases */ },
    async adopt() { return null; },
  },
} as unknown as WireDeps);

describe("contract §9.1 — memberships on the wire ctx", () => {
  it("resolves the seam once and stashes the result on the ctx", async () => {
    let calls = 0;
    const resolve = createContextResolver(
      depsFor({
        principal: { kind: "user", subject: "dana" },
        memberships: async (principal) => {
          calls += 1;
          return [{ org: "maple", display: "Maple", admin: principal.subject === "dana" }];
        },
      }),
      {},
    );
    const ctx = await resolve(request(), "app");
    expect(ctx.memberships).toEqual([{ org: "maple", display: "Maple", admin: true }]);
    expect(calls).toBe(1);
  });

  it("leaves memberships absent when the host wired no seam", async () => {
    const resolve = createContextResolver(depsFor({ principal: { kind: "user", subject: "dana" } }), {});
    expect((await resolve(request(), "app")).memberships).toBeUndefined();
  });

  it("asserts nothing for an anonymous visitor", async () => {
    const resolve = createContextResolver(
      depsFor({ principal: null, memberships: async () => [{ org: "maple" }] }),
      {},
    );
    const ctx = await resolve(request(), "app");
    expect(ctx.principal.ephemeral).toBe(true);
    expect(ctx.memberships).toBeUndefined();
  });

  // The red half of the gate: a host resolver that mints an org principal is
  // still refused outright — org context is DERIVED from membership (§9.1).
  it("still refuses a kind:\"org\" principal from the host resolver", async () => {
    const resolve = createContextResolver(
      depsFor({ principal: { kind: "org", subject: "maple" }, memberships: async () => [] }),
      {},
    );
    await expect(resolve(request(), "app")).rejects.toBeInstanceOf(VendoError);
  });
});
