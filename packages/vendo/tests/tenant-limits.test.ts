import type { LimitAction, LimitUser, LimitWindow, TenantDirectoryPayload } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { CloudDirectory } from "../src/cloud-directory.js";
import { tenantLimits } from "../src/tenant-limits.js";

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
    expect(asked).toEqual([{ days: 30, pool: "org:acme" }]);
  });

  it("counts a per-member cap against the subject, with no pool", async () => {
    const payload = acme({ acme: { messagesPerDay: { limit: 50, scope: "per-member" } } });
    const { verdict, asked } = await ask(payload, member, "message", { me: 50 });
    expect(verdict).toEqual({ allow: false, message: "You've used your 50 messages for today." });
    expect(asked).toEqual([{ days: 1 }]);
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
