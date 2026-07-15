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
  readSse,
  resetFixture,
  resumeApproval,
  textTurn,
  toolCallTurn,
  vendoApprovalId,
  type Stack,
} from "./harness.js";

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

    const first = await readSse(
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
    const firstApprovalId = vendoApprovalId(first);

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

    const resumed = await readSse(
      await resumeApproval(stack, "thr_grant_invalidation", "call_grant_v1", true, ADA),
    );
    expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
      toolCallId: "call_grant_v1",
      output: { status: "ok" },
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

    const second = await readSse(
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
      }, ADA),
    );
    expect(partsOfType(second, "tool-approval-request")[0]).toMatchObject({
      toolCallId: "call_grant_v2",
    });
    const secondApprovalId = vendoApprovalId(second);

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
  });
});
