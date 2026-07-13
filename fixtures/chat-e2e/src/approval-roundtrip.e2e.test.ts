/** Scenario 1 — FULL APPROVAL ROUND-TRIP across the real chat path.
 *
 * scripted model calls a tool a policy rule asks on → the stream surfaces the
 * ai-SDK approval + the VendoApprovalPart → SQL shows a pending vendo_approvals
 * row → guard.approvals.decide(approve, remember standing tool-scope) → resume
 * → the tool runs exactly once → the approval is decided/consumed, a
 * vendo_grants row is minted source "chat", the audit trail records it → a
 * SECOND turn calling the same tool matches the grant and runs without asking.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnv,
  descriptor,
  lastAssistant,
  partsOfType,
  readSse,
  respondToApproval,
  scriptedModel,
  SpyRegistry,
  textTurn,
  toolCallTurn,
  userCtx,
  userMessage,
  vendoApprovalId,
  auditEvents,
  type Env,
} from "./harness.js";

const SUBJECT = "user_ada";
const THREAD = "thr_roundtrip";
const TOOL = "host_invoices_send";
const input1 = { invoiceId: "inv_1" };
const input2 = { invoiceId: "inv_2" };

const send = descriptor({ name: TOOL, risk: "write" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 1: full approval round-trip", () => {
  it("asks, mints a standing grant on approve, runs once, then runs the second call without asking", async () => {
    env = await createEnv({ policy: { rules: [{ match: { tool: TOOL }, action: "ask" }] } });
    const registry = new SpyRegistry([send], { [TOOL]: { sent: true } });
    const model = scriptedModel([
      toolCallTurn(TOOL, input1, "call_1"), // stream #1: pauses on approval
      textTurn("Sent the invoice.", "t1"), //  stream #2 (resume): after execute
      toolCallTurn(TOOL, input2, "call_2"), // stream #3: runs via grant
      textTurn("Sent again.", "t2"), //          stream #3 continues after run
    ]);
    const agent = env.agentFor(registry, model);
    const ctx = userCtx(SUBJECT);

    // --- Turn 1: model calls the tool, the turn pauses on approval ----------
    const paused = await readSse(
      await agent.stream({ threadId: THREAD, message: userMessage("u1", "Send invoice 1"), ctx }),
    );

    expect(partsOfType(paused, "tool-approval-request")[0]).toMatchObject({ toolCallId: "call_1" });
    const vendoPart = partsOfType(paused, "data-vendo-approval")[0];
    expect(vendoPart).toMatchObject({ data: { toolCallId: "call_1", risk: "write" } });
    expect(String((vendoPart!.data as { approvalId?: unknown }).approvalId)).toMatch(/^apr_/);
    expect(paused.parts.at(-1)).toEqual({ type: "finish", finishReason: "tool-calls" });
    // Nothing executed; exactly one pending approval on disk.
    expect(registry.count(TOOL)).toBe(0);
    expect(await env.count("vendo_approvals")).toBe(1);
    const pendingRow = await env.sql<{ status: string; subject: string }>(
      "SELECT status, subject FROM vendo_approvals",
    );
    expect(pendingRow[0]).toEqual({ status: "pending", subject: SUBJECT });

    const approvalId = vendoApprovalId(paused);
    const pending = await env.guard.approvals.pending(ctx.principal);
    expect(pending.map((request) => request.id)).toEqual([approvalId]);

    // --- Decide: approve + remember a standing tool-scope grant -------------
    await env.guard.approvals.decide(
      approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      ctx.principal,
    );

    const approvalRow = await env.sql<{ status: string }>(
      "SELECT status FROM vendo_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approvalRow[0]?.status).toBe("approved");

    const grants = await env.sql<{ subject: string; tool: string; source: string; app_id: string | null; duration: string }>(
      "SELECT subject, tool, source, app_id, duration FROM vendo_grants",
    );
    expect(grants).toEqual([
      { subject: SUBJECT, tool: TOOL, source: "chat", app_id: null, duration: "standing" },
    ]);

    // --- Turn 2: resume the paused turn; the tool runs exactly once ---------
    const assistant = await lastAssistant(agent, THREAD, ctx);
    const resumed = await readSse(
      await agent.stream({
        threadId: THREAD,
        message: respondToApproval(assistant, "call_1", TOOL, input1, true),
        ctx,
      }),
    );

    expect(registry.count(TOOL)).toBe(1);
    expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
      toolCallId: "call_1",
      output: { status: "ok", output: { sent: true } },
    });
    expect(resumed.parts.some((part) => part.type === "text-delta" && part.delta === "Sent the invoice.")).toBe(true);

    const consumed = await env.sql<{ consumed_at: unknown }>(
      "SELECT consumed_at FROM vendo_approvals WHERE id = $1",
      [approvalId],
    );
    expect(consumed[0]?.consumed_at).not.toBeNull();

    // Audit trail: an approval event, the decide event, and the executed
    // tool-call (decidedBy grant — the consumed approval authorized it).
    const events = await auditEvents(env, SUBJECT);
    const toolCall = events.find((event) => event.kind === "tool-call");
    expect(toolCall).toMatchObject({ tool: TOOL, outcome: "ok", decidedBy: "grant" });
    expect(events.some((event) => event.kind === "approval" && event.outcome === "pending-approval")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "approval"
          && (event.detail as { approved?: boolean } | undefined)?.approved === true,
      ),
    ).toBe(true);

    // --- Turn 3: a fresh call to the same tool matches the grant ------------
    const secondTurn = await readSse(
      await agent.stream({ threadId: THREAD, message: userMessage("u2", "Send invoice 2"), ctx }),
    );
    expect(partsOfType(secondTurn, "tool-approval-request")).toHaveLength(0);
    expect(registry.count(TOOL)).toBe(2);
    // No new approval row: the grant answered the second call.
    expect(await env.count("vendo_approvals")).toBe(1);
  });
});
