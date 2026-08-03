/** J2 — DESTRUCTIVE APPROVAL ROUND-TRIP through the composed wire.
 *
 * A chat turn calls a destructive host tool (host_invoices_delete, DELETE
 * /api/invoices/{id}). The composed policy (.vendo/policy.json: destructive →
 * ask) parks it: the SSE turn pauses with an approval part and the request lands
 * queryable at GET /approvals. Deciding approve+remember over the wire mints a
 * grant; resuming the thread executes the real HTTP DELETE against the host app.
 * A second turn runs grant-authorized without asking.
 *
 * Also proves the one-security-rule cross-user boundary: BOB cannot decide ADA's
 * approval (guard → not-found → 404), and nothing runs off it.
 *
 * NB the task brief named host_invoices_archive → POST /api/invoices/archive as
 * the destructive tool; the fixture host app has no such mutating route (its
 * /api/invoices/archive is a GET read). host_invoices_delete is the real
 * destructive mutation the host exposes, so the journey asserts a REAL side
 * effect (the invoice is gone) rather than a 405.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  BOB,
  createStack,
  hostFetch,
  partsOfType,
  readSse,
  readSseMidStream,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
} from "./harness.js";

const TOOL = "host_invoices_delete";
const FIRST = "inv_0003"; // ADA's draft invoice
const SECOND = "inv_0002"; // ADA's open invoice

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

async function invoiceExists(id: string): Promise<boolean> {
  return (await hostFetch(`/api/invoices/${id}`, ADA.subject)).status === 200;
}

describe("J2: destructive approval round-trip through the composed wire", () => {
  it("parks, blocks a cross-user decide, then approve+remember executes for real and the grant authorizes the next call", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn(TOOL, { id: FIRST }, "call_1"), // turn 1: parks on the destructive-ask policy
        textTurn("Deleted the invoice.", "t1"), //       resume: executes the real DELETE, then text
        toolCallTurn(TOOL, { id: SECOND }, "call_2"), //  turn 2: grant-authorized, no ask
        textTurn("Deleted again.", "t2"), //              turn 2: continues after the run
      ],
    });

    // --- Turn 1: the destructive call parks --------------------------------
    // Build contract §1.4: the guarded call BLOCKS inside the tool call
    // awaiting the tap, holding this same request open — it does not park the
    // whole turn for a later, separately-posted resume. Everything below runs
    // against the SAME still-open stream, synchronized on the approval card.
    const paused = readSseMidStream(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_j2",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: `Delete invoice ${FIRST}` }] },
        }),
      }, ADA),
    );

    // Build contract §1.5: tool calls are mirrored by the RUNTIME on its own
    // freshly-minted id — never the scripted model's own toolCallId ("call_1"
    // only ever reached the wire under `createAgent`'s direct ai-SDK
    // pass-through). Capture the runtime's id instead of asserting the literal.
    const approvalCard = await paused.approval;
    const toolCallId = approvalCard.toolCallId;
    const approvalId = approvalCard.approvalId;
    if (approvalId === undefined) throw new Error("approval card carried no approvalId");

    // Nothing executed: one pending approval on disk, host invoice untouched.
    const pendingRows = await stack.sql<{ status: string; subject: string }>(
      "SELECT status, subject FROM vendo_approvals",
    );
    expect(pendingRows).toEqual([{ status: "pending", subject: ADA.subject }]);
    expect(await invoiceExists(FIRST)).toBe(true);

    // GET /approvals surfaces the real inputs (05 §6 inputPreview).
    const pending = (await (await stack.wireFetch("/approvals", {}, ADA)).json()) as Array<{
      id: string;
      inputPreview: string;
    }>;
    expect(pending.map((request) => request.id)).toContain(approvalId);
    expect(pending.find((request) => request.id === approvalId)?.inputPreview).toContain(FIRST);

    // --- Cross-user boundary: BOB cannot decide ADA's approval -------------
    const bobDecide = await stack.wireFetch("/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ ids: [approvalId], decision: { approve: true } }),
    }, BOB);
    expect(bobDecide.status).toBe(404);
    // Still pending, still nothing deleted.
    expect((await stack.sql("SELECT status FROM vendo_approvals WHERE status = 'pending'"))).toHaveLength(1);
    expect(await invoiceExists(FIRST)).toBe(true);

    // --- ADA decides: approve + remember a standing tool-scope grant -------
    const decide = await stack.wireFetch("/approvals/decide", {
      method: "POST",
      body: JSON.stringify({
        ids: [approvalId],
        decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      }),
    }, ADA);
    expect(decide.status).toBe(200);

    const grants = await stack.sql<{ id: string; subject: string; tool: string; source: string; duration: string }>(
      "SELECT id, subject, tool, source, duration FROM vendo_grants",
    );
    expect(grants).toEqual([
      expect.objectContaining({ subject: ADA.subject, tool: TOOL, source: "chat", duration: "standing" }),
    ]);
    const grantId = grants[0]!.id;

    // --- The decision above unblocks the still-open call: the real DELETE
    // runs against the host, and the SAME stream carries the reply. --------
    // Build contract §1.1: the wire's `output` is the tool's OWN return value
    // (`outcome.output`) — the harness narrows to ok/error/denied at the
    // result-status level rather than nesting a `status` field inside it, the
    // way `createAgent`'s raw-outcome pass-through used to.
    const resumed = await paused.done;
    expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
      toolCallId,
      output: { ok: true },
    });
    expect(resumed.raw.includes("Deleted the invoice.")).toBe(true);

    // Real host side effect: the invoice is gone.
    expect(await invoiceExists(FIRST)).toBe(false);

    // Audit: the executed destructive tool-call authorized by the grant.
    const audit = await stack.sql<{ kind: string; tool: string; event: { outcome?: string; decidedBy?: string } }>(
      "SELECT kind, tool, event FROM vendo_audit WHERE subject = $1",
      [ADA.subject],
    );
    const toolCall = audit.find((row) => row.kind === "tool-call" && row.tool === TOOL && row.event.outcome === "ok");
    expect(toolCall?.event.decidedBy).toBe("grant");
    expect(audit.some((row) => row.kind === "approval")).toBe(true);

    // --- Turn 2: a fresh destructive call runs on the grant, no new ask ----
    const second = await readSse(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_j2",
          message: { id: "u2", role: "user", parts: [{ type: "text", text: `Delete invoice ${SECOND}` }] },
        }),
      }, ADA),
    );
    // No fresh ask: the standing grant answered the call, so no approval card
    // rides this turn's wire (the wire's only "asking" affordance now).
    expect(partsOfType(second, "data-vendo-approval")).toHaveLength(0);
    expect(await invoiceExists(SECOND)).toBe(false);
    // No new approval row: the grant answered the second call.
    expect(await stack.sql("SELECT id FROM vendo_approvals")).toHaveLength(1);

    // Audit enrichment (ENG-264): the grant-decided call carries the deciding
    // grant's id in the persisted event detail. Assert on the fresh turn-2
    // call — the resumed call_1 is a single-use approval REPLAY, which is
    // decidedBy "grant" with no grantId by design.
    const enriched = await stack.sql<{
      event: { inputPreview?: string; decidedBy?: string; detail?: { grantId?: string } };
    }>(
      "SELECT event FROM vendo_audit WHERE kind = 'tool-call' AND tool = $1 AND subject = $2",
      [TOOL, ADA.subject],
    );
    const grantRun = enriched.find((row) => row.event.inputPreview?.includes(SECOND));
    expect(grantRun?.event.decidedBy).toBe("grant");
    expect(grantRun?.event.detail?.grantId).toBe(grantId);
  });
});
