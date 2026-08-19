import type { LimitAction, LimitsCallback, TenantLimits } from "@vendoai/core";
import type { CloudDirectory } from "./cloud-directory.js";

/**
 * The Cloud-default `LimitsCallback`: the caps the customer set in the console,
 * read off the SAME cached directory entry the memberships seam already
 * resolved for this request, so a cap costs zero extra requests.
 *
 * Each cap's `scope` chooses the window and nothing else — `per-tenant` hands
 * `count` the `org:<tenantId>` pool, `per-member` hands it nothing and counts
 * the subject. Neither spelling is new grammar; the limiter already speaks both.
 */

/** Which cap governs which metered action, and the span each is counted over. */
const CAPS: Record<LimitAction, { key: keyof TenantLimits; days: number; noun: string; span: string }> = {
  message: { key: "messagesPerDay", days: 1, noun: "messages", span: "for today" },
  generation: { key: "generationsPerMonth", days: 30, noun: "generations", span: "for this month" },
};

export function tenantLimits(directory: CloudDirectory): LimitsCallback {
  return async ({ user, action, count }) => {
    const { key, days, noun, span } = CAPS[action];
    const { memberships, limits } = await directory.entry(user);
    for (const { org, display } of memberships) {
      const cap = limits[org]?.[key];
      if (cap === undefined) continue;
      const pool = `org:${org}`;
      // Guarded exactly as a host's own org policy is: counting a pool the user
      // is not in throws, and a throw is a deny with no message. A signed-out
      // visitor, an inbound text, a directory miss — all must fall through.
      if (cap.scope === "per-tenant" && user.pools?.includes(pool) !== true) continue;
      const used = await count(action, cap.scope === "per-tenant" ? { days, pool } : { days });
      if (used < cap.limit) continue;
      const who = cap.scope === "per-tenant" ? `${display ?? org} has used its` : "You've used your";
      return { allow: false, message: `${who} ${cap.limit.toLocaleString("en-US")} ${noun} ${span}.` };
    }
    return true;
  };
}
