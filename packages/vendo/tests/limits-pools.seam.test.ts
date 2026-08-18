/**
 * The pools lane, END TO END, with nothing stubbed on either side.
 *
 * `ctx.pools` shipped with a producer and no consumer: the auth preset resolves
 * it, five hops carry it, and until the limiter nothing read it — so the whole
 * lane was proven by typecheck, which is exactly the shape that shipped the
 * host-component previews dead four times (a producer and a consumer each
 * mocking the other can never disagree).
 *
 * So this drives ONE request the whole way: a real HS256 host session → the real
 * `jwt()` preset's user resolver, returning real pools → the real composition's
 * seam → the real wire context resolver → the real limiter → a real PGlite
 * meter, read back through the real read path.
 *
 * Break ANY hop — the preset's `pools`, `composeConfig`'s `userPoolsSeam`,
 * `wireDepsFor`'s `userPools`, the context resolver's stash — and `ctx.pools` is
 * absent, the policy's `count({ pool: "workspace" })` hits an unknown meter, and
 * the gate fails closed. The `allow: true` below is what makes every hop
 * load-bearing.
 *
 * The second case drives the same hops for a user the host asserted NOTHING but
 * an org: the `org:<id>` pool is derived, not resolved, so a break anywhere from
 * the `memberships` seam to the limiter's derivation reads as an unknown meter.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import type { LimitUser, PermissionGrant } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createComposition } from "../src/compose-context.js";
import { wireDepsFor } from "../src/compose-wire.js";
import { createContextResolver } from "../src/wire/context.js";

const SECRET = "vendo-limits-pools-seam-secret-with-entropy";
const ALL_TIME = new Date(0);

/** The host's own user table: Mia's usage also draws down her workspace. */
const users: Record<string, { display: string; pools: Record<string, string> }> = {
  host_mia: { display: "Mia", pools: { workspace: "ws_maple" } },
};

const grant = (subject: string): PermissionGrant => ({
  id: "grt_limits_pools_seam",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:limits-pools-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-15T00:00:00.000Z",
});

/** A REAL host session, minted hermetically by the shipped actions-side preset
    the verifying half was built against. */
async function sessionRequest(subject: string): Promise<Request> {
  const mint = genericJwtPreset({ secret: SECRET, claims: () => ({}) });
  const material = await mint({ kind: "user", subject }, grant(subject));
  return new Request("https://host.test/api/vendo/threads", { headers: material!.headers });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function realStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-limits-pools-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

describe("limits — the host's pools reach the policy and the meter", () => {
  it("counts a teammate's spend against the shared meter, and the allow accrues to it too", async () => {
    let seen: { user: LimitUser; pooled: number } | undefined;

    const composition = createComposition({
      store: await realStore(),
      auth: jwt({ secret: SECRET, user: (subject) => users[subject] ?? null }),
      limits: async ({ user, count }) => {
        seen = { user, pooled: await count("message", { pool: "workspace" }) };
        return true;
      },
    });
    await composition.ready();
    const usage = composition.ops!.usage!;

    // A TEAMMATE already spent one message against the same workspace. Mia has
    // spent nothing herself, so any number the policy sees can only have come
    // through ctx.pools.
    await usage.record({
      subject: "host_raj",
      action: "message",
      at: new Date(),
      poolKeys: ["ws_maple"],
    });

    const ctx = await createContextResolver(wireDepsFor(composition))(
      await sessionRequest("host_mia"),
      "chat",
    );

    await expect(composition.limiter!.gate("message", ctx)).resolves.toEqual({ allow: true });

    expect(seen?.user.subject).toBe("host_mia");
    expect(seen?.user.pools).toEqual(["workspace"]);
    expect(seen?.pooled).toBe(1);
    // …and Mia's own allow was stamped with the same pool key, so the next read
    // of the shared meter sees both.
    expect(await usage.count({ action: "message", poolKey: "ws_maple", since: ALL_TIME })).toBe(2);
    expect(await usage.count({ action: "message", subject: "host_mia", since: ALL_TIME })).toBe(1);
  });
});

describe("limits — an asserted org is a pool with nothing wired for it", () => {
  it("counts and accrues to `org:<id>` from a membership alone, over the same real hops", async () => {
    let seen: { user: LimitUser; pooled: number } | undefined;

    const composition = createComposition({
      store: await realStore(),
      // Ana has NO `pools` of her own — the org is the only thing asserted about
      // her, so every pool the policy sees below can only have been derived.
      auth: jwt({
        secret: SECRET,
        user: (subject) => (subject === "host_ana" ? { display: "Ana" } : null),
        memberships: async () => [{ org: "maple", display: "Maple Bank", teams: ["support"] }],
      }),
      limits: async ({ user, count }) => {
        seen = { user, pooled: await count("message", { pool: "org:maple" }) };
        return true;
      },
    });
    await composition.ready();
    const usage = composition.ops!.usage!;

    // A colleague already spent one against the key the DERIVATION mints.
    await usage.record({
      subject: "host_raj",
      action: "message",
      at: new Date(),
      poolKeys: ["org:maple"],
    });

    const ctx = await createContextResolver(wireDepsFor(composition))(
      await sessionRequest("host_ana"),
      "chat",
    );

    await expect(composition.limiter!.gate("message", ctx)).resolves.toEqual({ allow: true });

    expect(seen?.user.pools).toEqual(["org:maple"]);
    expect(seen?.pooled).toBe(1);
    expect(await usage.count({ action: "message", poolKey: "org:maple", since: ALL_TIME })).toBe(2);
    // Her team was asserted too and is deliberately NOT a pool.
    expect(await usage.count({ action: "message", poolKey: "team:maple/support", since: ALL_TIME })).toBe(0);
  });
});
