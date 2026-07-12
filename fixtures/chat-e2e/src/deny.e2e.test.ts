/** Scenario 2 — DENY PATH.
 *
 * The model calls an asked tool → the user denies → the tool never executes,
 * the model is told (SDK denied output), no grant is minted, and the approval
 * row lands `denied`.
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
  type Env,
} from "./harness.js";

const SUBJECT = "user_deny";
const THREAD = "thr_deny";
const TOOL = "host_invoices_delete";
const input = { invoiceId: "inv_9" };
const del = descriptor({ name: TOOL, risk: "destructive" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 2: deny path", () => {
  it("never executes the tool, tells the model, mints no grant, and marks the approval denied", async () => {
    env = await createEnv({ policy: { rules: [{ match: { tool: TOOL }, action: "ask" }] } });
    const registry = new SpyRegistry([del]);
    const model = scriptedModel([
      toolCallTurn(TOOL, input, "call_1"),
      textTurn("Understood — I won't delete it.", "t1"),
    ]);
    const agent = env.agentFor(registry, model);
    const ctx = userCtx(SUBJECT);

    const paused = await readSse(
      await agent.stream({ threadId: THREAD, message: userMessage("u1", "Delete invoice 9"), ctx }),
    );
    const approvalId = vendoApprovalId(paused);
    expect(await env.count("vendo_approvals")).toBe(1);

    // Deny — no `remember`, so no grant.
    await env.guard.approvals.decide(approvalId, { approve: false }, ctx.principal);

    const assistant = await lastAssistant(agent, THREAD, ctx);
    const resumed = await readSse(
      await agent.stream({
        threadId: THREAD,
        message: respondToApproval(assistant, "call_1", TOOL, input, false),
        ctx,
      }),
    );

    // Spy proves the registry was never executed.
    expect(registry.count(TOOL)).toBe(0);
    // The model was told via the SDK denied output, and still produced a turn.
    expect(partsOfType(resumed, "tool-output-denied")[0]).toMatchObject({ toolCallId: "call_1" });
    expect(resumed.parts.some((part) => part.type === "text-delta" && part.delta === "Understood — I won't delete it.")).toBe(true);

    // SQL: approval denied, zero grants.
    const approvalRow = await env.sql<{ status: string }>(
      "SELECT status FROM vendo_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approvalRow[0]?.status).toBe("denied");
    expect(await env.count("vendo_grants")).toBe(0);
  });
});
