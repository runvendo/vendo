import type { LimitAction, LimitUser, LimitWindow, StoreOps, TenantDirectoryPayload } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { describe, expect, it, vi } from "vitest";
import type { CloudDirectory } from "../src/cloud-directory.js";
import { createLimiter } from "../src/limits.js";
import { tenantLimits } from "../src/tenant-limits.js";

/** The period each cap is counted over, restated — the tests say what the
    windows MEAN, and the boundary cases below say what they DO. */
const startOfUTCDay = (now = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUTCMonth = (now = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** A directory that answers one fixed payload — the cache is Task 2's subject,
    not this one's. */
const directoryOf = (payload: TenantDirectoryPayload): CloudDirectory => ({
  entry: async () => payload,
  memberships: async () => payload.memberships,
});

const acme = (limits: TenantDirectoryPayload["limits"]): TenantDirectoryPayload => ({
  memberships: [{ org: "acme", display: "Acme Corp" }],
  limits,
});

/** Ask the policy with a meter that answers `counts` per pool ("me" = this
    user alone) and remembers every window it was asked for. */
async function ask(
  payload: TenantDirectoryPayload,
  user: LimitUser,
  action: LimitAction,
  counts: Record<string, number> = {},
) {
  const asked: LimitWindow[] = [];
  const verdict = await tenantLimits(directoryOf(payload))({
    user,
    action,
    count: async (_action, window) => {
      asked.push(window ?? {});
      return counts[window?.pool ?? "me"] ?? 0;
    },
  });
  return { verdict, asked };
}

const member: LimitUser = { kind: "user", subject: "u_bob", pools: ["org:acme"] };
const guest: LimitUser = { kind: "user", subject: "maple_guest", ephemeral: true };

describe("tenantLimits", () => {
  it("counts a per-tenant cap against the org pool and names the company", async () => {
    const payload = acme({ acme: { generationsPerMonth: { limit: 1000, scope: "per-tenant" } } });
    expect(await ask(payload, member, "generation", { "org:acme": 999 }))
      .toMatchObject({ verdict: true });
    const { verdict, asked } = await ask(payload, member, "generation", { "org:acme": 1000 });
    expect(verdict).toEqual({
      allow: false,
      message: "Acme Corp has used its 1,000 generations for this month.",
    });
    expect(asked).toEqual([{ since: startOfUTCMonth(), pool: "org:acme" }]);
  });

  it("counts a per-member cap against the subject, with no pool", async () => {
    const payload = acme({ acme: { messagesPerDay: { limit: 50, scope: "per-member" } } });
    const { verdict, asked } = await ask(payload, member, "message", { me: 50 });
    expect(verdict).toEqual({ allow: false, message: "You've used your 50 messages for today." });
    expect(asked).toEqual([{ since: startOfUTCDay() }]);
  });

  // Counting a pool the user is not in THROWS, and a throw is a DENY with no
  // message — which would read as a cap they never hit. Every guest, ephemeral
  // principal and directory miss must fall through this guard.
  it("allows, and counts nothing, when the user is in no pool", async () => {
    const payload = acme({ acme: { generationsPerMonth: { limit: 1, scope: "per-tenant" } } });
    const { verdict, asked } = await ask(payload, guest, "generation");
    expect(verdict).toBe(true);
    expect(asked).toEqual([]);
  });

  it("still applies a per-member cap to a member whose pool has not resolved", async () => {
    const payload = acme({ acme: { messagesPerDay: { limit: 5, scope: "per-member" } } });
    const poolless: LimitUser = { kind: "user", subject: "u_bob" };
    const { verdict } = await ask(payload, poolless, "message", { me: 5 });
    expect(verdict).toMatchObject({ allow: false });
  });

  it("reads nothing at all when the tenant has no cap for this action", async () => {
    const payload = acme({ acme: { messagesPerDay: { limit: 5, scope: "per-member" } } });
    const { verdict, asked } = await ask(payload, member, "generation");
    expect(verdict).toBe(true);
    expect(asked).toEqual([]);
  });

  it("falls back to the tenant id when the console sent no display name", async () => {
    const payload: TenantDirectoryPayload = {
      memberships: [{ org: "acme" }],
      limits: { acme: { generationsPerMonth: { limit: 2, scope: "per-tenant" } } },
    };
    const { verdict } = await ask(payload, member, "generation", { "org:acme": 2 });
    expect(verdict).toMatchObject({ message: "acme has used its 2 generations for this month." });
  });
});

/**
 * The caps say "for today" and "for this month", so they reset on the CALENDAR
 * boundary, not 24h/30d after whenever the user last acted. A rolling lookback
 * and a calendar period agree on almost every instant, so the only test that can
 * tell them apart is one that straddles a boundary.
 *
 * Driven through the REAL limiter and the REAL reference meter: the usage is
 * genuinely recorded at a past instant and genuinely filtered by `since`, so
 * nothing here can pass by agreeing with itself. Only the clock is pinned, and
 * only so the boundary is a fixed point instead of whenever CI happened to run.
 */
describe("a cap's period is the calendar's, not a rolling lookback", () => {
  const gateAcross = async (opts: {
    now: string;
    used: string;
    action: LimitAction;
    limits: TenantDirectoryPayload["limits"];
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const usage = memoryStoreOps().usage as NonNullable<StoreOps["usage"]>;
      await usage.record({ subject: "u_bob", action: opts.action, at: new Date(opts.used) });
      vi.setSystemTime(new Date(opts.now));
      const limiter = createLimiter({
        callback: tenantLimits(directoryOf(acme(opts.limits))),
        ops: usage,
      });
      return await limiter.gate(opts.action, {
        principal: { kind: "user", subject: "u_bob" },
        venue: "chat",
        presence: "present",
        sessionId: "s_boundary",
      });
    } finally {
      vi.useRealTimers();
    }
  };

  it("does not spend today's messages on a message sent yesterday", async () => {
    // One message at 23:59, one minute later it is a new day. A 24h lookback
    // still sees it and denies; "for today" must not.
    expect(await gateAcross({
      now: "2026-03-15T00:01:00Z",
      used: "2026-03-14T23:59:00Z",
      action: "message",
      limits: { acme: { messagesPerDay: { limit: 1, scope: "per-member" } } },
    })).toEqual({ allow: true });
  });

  it("does not spend this month's generations on one made last month", async () => {
    // Same instant-apart trick across the month end: a 30-day lookback reaches
    // back into February and denies; "for this month" must not.
    expect(await gateAcross({
      now: "2026-03-01T00:01:00Z",
      used: "2026-02-28T23:59:00Z",
      action: "generation",
      limits: { acme: { generationsPerMonth: { limit: 1, scope: "per-member" } } },
    })).toEqual({ allow: true });
  });

  it("still denies inside the same calendar period", async () => {
    // The guard on the guard: if these windows denied nothing, the two cases
    // above would pass against a cap that had simply stopped working.
    expect(await gateAcross({
      now: "2026-03-15T23:59:00Z",
      used: "2026-03-15T00:01:00Z",
      action: "message",
      limits: { acme: { messagesPerDay: { limit: 1, scope: "per-member" } } },
    })).toMatchObject({ allow: false });
  });
});
