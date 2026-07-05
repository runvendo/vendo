/**
 * Guard-boundary derivation in the `parkedActions` seam adapter (review
 * follow-up): the adapter must use the SAME steps-reference boundary the
 * runner's resolve-time re-check uses — dot AND bracket forms both count.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listParkedActions } from "./parked-actions";

function fetchReturning(actions: unknown[]): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ actions }),
  })) as unknown as typeof fetch;
}

const raw = (id: string, guardExpr?: string) => ({
  id,
  tool: "GMAIL_SEND_EMAIL",
  tier: "act" as const,
  input: { to: "a@x.com" },
  requestedAt: "2026-07-04T00:00:00Z",
  ...(guardExpr !== undefined ? { guardExpr } : {}),
});

describe("listParkedActions guardStale derivation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flags dot AND bracket steps references as guardStale; self-contained/absent guards stay unflagged", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning([
        raw("p1", "steps.fetch.output.count > 0"),
        raw("p2", 'steps["fetch"].output.count > 0'),
        raw("p3", "trigger.amountDue > 0"),
        raw("p4"),
      ]),
    );
    const rows = await listParkedActions();
    expect(rows.map((r) => r.guardStale)).toEqual([true, true, false, false]);
  });
});
