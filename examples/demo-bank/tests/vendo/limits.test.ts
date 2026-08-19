/**
 * Maple's shipped `limits` policy (./server.ts) — the org cap and the guard it
 * needs, because Maple serves identities it asserts no membership for.
 *
 * The `count` reader is the limiter's, and the limiter is not host surface, so it
 * is bound here instead: what the policy ASKS is the whole fact under test —
 * counting a pool the user is not in throws inside the real limiter, and a policy
 * that asks for one refuses the turn (proved in @vendoai/vendo's limits suite).
 * The identities are Maple's own seams, unmocked.
 */
import type { LimitUser, LimitWindow } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapleAuth, mapleLimits } from "../../src/vendo/server";

afterEach(() => vi.unstubAllEnvs());

const THREADS = "http://localhost:3000/api/vendo/threads";

/** Ask the policy, with a meter that answers `counts` per pool ("me" = this user
    alone) and remembers every window it was asked for. */
async function ask(user: LimitUser, counts: Record<string, number> = {}) {
  const asked: LimitWindow[] = [];
  const verdict = await mapleLimits({
    user,
    action: "message",
    count: async (_action, window) => {
      asked.push(window ?? {});
      return counts[window?.pool ?? "me"] ?? 0;
    },
  });
  return { verdict, pooled: asked.filter(({ pool }) => pool !== undefined) };
}

const member: LimitUser = { kind: "user", subject: "vendo-demo", pools: ["org:maple"] };

describe("Maple's limits policy", () => {
  it("shares the branch's 200 monthly messages across its members", async () => {
    // `pools: ["org:maple"]` above is what the limiter derives from THIS seam.
    await expect(mapleAuth.memberships?.({ kind: "user", subject: "vendo-demo" }))
      .resolves.toMatchObject([{ org: "maple", admin: true }]);

    expect(await ask(member, { "org:maple": 199 })).toMatchObject({ verdict: true });
    const { verdict } = await ask(member, { "org:maple": 200 });
    expect(verdict).toMatchObject({ allow: false, message: expect.stringContaining("200 shared messages") });
  });

  it("still caps one person's day inside the shared allowance", async () => {
    const { verdict } = await ask(member, { me: 50 });
    expect(verdict).toMatchObject({ allow: false, message: expect.stringContaining("50 messages for today") });
  });

  it("never counts the org pool for an identity Maple asserts no membership for", async () => {
    // Two real ones: the signed-out visitor Maple resolves to a shared ephemeral
    // guest, and an inbound text — `runChannelTurn` builds its own ctx and asks no
    // memberships seam, so that turn's user carries no pools either.
    const guest = await mapleAuth.principal(new Request(THREADS));
    expect(guest).toEqual({ kind: "user", subject: "maple_guest", ephemeral: true });
    await expect(mapleAuth.memberships?.(guest!)).resolves.toEqual([]);

    const { verdict, pooled } = await ask(guest!);
    expect(verdict).toBe(true);
    expect(pooled).toEqual([]);
  });

  it("keeps working in the DEPLOYED posture, where auto-login needs no password env", async () => {
    // No MAPLE_DEMO_PASSWORD in production means no seeded users to resolve, so
    // Maple asserts nothing about anyone and the org pool exists for no one.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAPLE_DEMO_PASSWORD", undefined);
    await expect(mapleAuth.memberships?.({ kind: "user", subject: "vendo-demo" })).resolves.toEqual([]);

    expect(await ask({ kind: "user", subject: "vendo-demo" })).toMatchObject({ verdict: true, pooled: [] });
  });
});
