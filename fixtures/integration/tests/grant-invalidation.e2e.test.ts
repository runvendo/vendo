/** ENG-261 — descriptor drift invalidates standing grants loudly through the
 * composed wire: the replacement approval identifies the stale grant and the
 * public audit table records one grant-invalidated policy decision. */
import { descriptorHash, type PermissionGrant } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADA,
  createStack,
  hostFetch,
  loginCookie,
  partsOfType,
  readSseMidStream,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
} from "../src/harness.js";

const TOOL = "host_invoices_delete";
const FIRST = "inv_0003";
const SECOND = "inv_0002";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

async function invoiceExists(id: string): Promise<boolean> {
  return (await hostFetch(`/api/invoices/${id}`, ADA.subject)).status === 200;
}

describe("ENG-261: loud grant invalidation through the composed wire", () => {
  it("parks with invalidatedGrant and persists the descriptor-drift audit event", async () => {
    await resetFixture();
    // A focused cold run may still be compiling the fixture's login route even
    // after the root + reset endpoints are ready. Prime it with the same retry
    // posture used by the browser fixture before the composed wire needs auth.
    await vi.waitFor(async () => {
      expect(await loginCookie(ADA.subject)).toContain("=");
    }, { timeout: 30_000 });
    stack = await createStack({
      turns: [
        toolCallTurn(TOOL, { id: FIRST }, "call_grant_v1"),
        textTurn("Deleted the first invoice.", "text_v1"),
        toolCallTurn(TOOL, { id: SECOND }, "call_grant_v2"),
      ],
    });

    // Build contract §1.4: the guarded call blocks INSIDE the tool call
    // awaiting the tap, holding this one request open — decide against the
    // still-open stream rather than a later, separately-posted resume.
    const first = readSseMidStream(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_grant_invalidation",
          message: {
            id: "user_v1",
            role: "user",
            parts: [{ type: "text", text: `Delete invoice ${FIRST}` }],
          },
        }),
      }, ADA),
    );
    const firstApprovalCard = await first.approval;
    const firstApprovalId = firstApprovalCard.approvalId;
    if (firstApprovalId === undefined) throw new Error("approval card carried no approvalId");

    const decided = await stack.wireFetch("/approvals/decide", {
      method: "POST",
      body: JSON.stringify({
        ids: [firstApprovalId],
        decision: {
          approve: true,
          remember: { scope: { kind: "tool" }, duration: "standing" },
        },
      }),
    }, ADA);
    expect(decided.status).toBe(200);

    const [grant] = (await (await stack.wireFetch("/grants", {}, ADA)).json()) as PermissionGrant[];
    expect(grant).toMatchObject({ tool: TOOL, duration: "standing", source: "chat" });
    if (grant === undefined) throw new Error("standing grant was not minted");

    // Build contract §1.5: tool calls are mirrored by the RUNTIME on its own
    // freshly-minted id — never the scripted model's own toolCallId — so the
    // correlation check is against the SAME card's id, not the model's literal.
    // Build contract §1.1: `output` is the tool's OWN return value, not a
    // second `status` wrapper (the old `createAgent` raw-outcome shape).
    const resumed = await first.done;
    expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
      toolCallId: firstApprovalCard.toolCallId,
      output: { ok: true },
    });
    expect(await invoiceExists(FIRST)).toBe(false);

    // The action registry is the same live registry guard binds for every turn.
    // Mutating its loaded descriptor simulates a host extraction/schema change
    // without rewriting the fixture's shared .vendo/tools.json on disk.
    const descriptor = (await stack.vendo.actions.descriptors()).find(
      (candidate) => candidate.name === TOOL,
    );
    if (descriptor === undefined) throw new Error(`fixture descriptor ${TOOL} was not loaded`);
    descriptor.description = `${descriptor.description} (descriptor v2)`;
    const currentHash = descriptorHash(descriptor);
    expect(currentHash).not.toBe(grant.descriptorHash);

    // This turn's call also blocks on the wire (§1.4) — but this journey never
    // decides it (the point is the invalidated-grant metadata on the pending
    // ask, not the eventual outcome), so the underlying request is aborted
    // once the assertions below are done rather than left to time out.
    const abortSecond = new AbortController();
    const second = readSseMidStream(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_grant_invalidation",
          message: {
            id: "user_v2",
            role: "user",
            parts: [{ type: "text", text: `Delete invoice ${SECOND}` }],
          },
        }),
        signal: abortSecond.signal,
      }, ADA),
    );
    const secondApprovalCard = await second.approval;
    expect(typeof secondApprovalCard.toolCallId).toBe("string");
    expect(secondApprovalCard).toMatchObject({
      invalidatedGrant: { id: grant.id, grantedAt: grant.grantedAt },
    });
    const secondApprovalId = secondApprovalCard.approvalId;
    if (secondApprovalId === undefined) throw new Error("approval card carried no approvalId");

    const pending = (await (await stack.wireFetch("/approvals", {}, ADA)).json()) as Array<{
      id: string;
      invalidatedGrant?: { id: string; grantedAt: string };
    }>;
    expect(pending.find((request) => request.id === secondApprovalId)).toMatchObject({
      invalidatedGrant: { id: grant.id, grantedAt: grant.grantedAt },
    });
    expect(await invoiceExists(SECOND)).toBe(true);

    const approvalRows = await stack.sql<{ invalidated_grant: unknown }>(
      `SELECT request->'invalidatedGrant' AS invalidated_grant
         FROM vendo_approvals WHERE id = $1`,
      [secondApprovalId],
    );
    expect(approvalRows).toEqual([
      { invalidated_grant: { id: grant.id, grantedAt: grant.grantedAt } },
    ]);

    const auditRows = await stack.sql<{
      event: {
        kind: string;
        outcome: string;
        decidedBy: string;
        tool: string;
        detail: Record<string, unknown>;
      };
    }>(
      `SELECT event FROM vendo_audit
        WHERE kind = 'policy-decision'
          AND event->'detail'->>'reason' = 'grant-invalidated'`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.event).toMatchObject({
      kind: "policy-decision",
      outcome: "pending-approval",
      decidedBy: "default",
      tool: TOOL,
      detail: {
        reason: "grant-invalidated",
        grantIds: [grant.id],
        tool: TOOL,
        staleHash: grant.descriptorHash,
        currentHash,
      },
    });

    // Never decided by design (see above) — cut the still-blocked request
    // short instead of waiting out the frozen approval bound.
    abortSecond.abort();
    await second.done.catch(() => {});
  });
});
