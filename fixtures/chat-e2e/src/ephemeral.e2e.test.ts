/** Scenario 5 — EPHEMERAL PRINCIPAL.
 *
 * An ephemeral principal runs a full turn including an approval decided in the
 * same session — everything works through the SAME disk path as any durable
 * subject (02 §4, kill-list B3: no overlay). The turn is proven live (the tool
 * ran, the thread is readable), and the subject's rows are ordinary vendo_*
 * rows a TTL sweep or erase cascade reclaims later.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnv,
  descriptor,
  ephemeralCtx,
  lastAssistant,
  partsOfType,
  readSse,
  respondToApproval,
  scriptedModel,
  SpyRegistry,
  textTurn,
  toolCallTurn,
  userMessage,
  vendoApprovalId,
  type Env,
} from "./harness.js";

const SUBJECT = "guest_ghost";
const THREAD = "thr_ghost";
const TOOL = "host_notes_write";
const input = { text: "hi" };
const write = descriptor({ name: TOOL, risk: "write" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 5: ephemeral principal", () => {
  it("runs a full approval turn in-session through the single disk path", async () => {
    env = await createEnv({ policy: { rules: [{ match: { tool: TOOL }, action: "ask" }] } });
    const registry = new SpyRegistry([write], { [TOOL]: { wrote: true } });
    const model = scriptedModel([
      toolCallTurn(TOOL, input, "call_1"),
      textTurn("Saved your note.", "t1"),
    ]);
    const agent = env.agentFor(registry, model);
    const ctx = ephemeralCtx(SUBJECT);

    // Turn 1: parks. The approval is queryable and on disk like any other.
    const paused = await readSse(
      await agent.stream({ threadId: THREAD, message: userMessage("u1", "Save a note"), ctx }),
    );
    const approvalId = vendoApprovalId(paused);
    const pending = await env.guard.approvals.pending(ctx.principal);
    expect(pending.map((request) => request.id)).toEqual([approvalId]);
    expect(await env.count("vendo_approvals")).toBe(1); // an ordinary disk row (B3)

    // Decide (remember standing) and resume in-session.
    await env.guard.approvals.decide(
      approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      ctx.principal,
    );
    const assistant = await lastAssistant(agent, THREAD, ctx);
    const resumed = await readSse(
      await agent.stream({
        threadId: THREAD,
        message: respondToApproval(assistant, "call_1", TOOL, input, true),
        ctx,
      }),
    );

    // The turn genuinely ran end-to-end.
    expect(registry.count(TOOL)).toBe(1);
    expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
      toolCallId: "call_1",
      output: { status: "ok", output: { wrote: true } },
    });
    const thread = await agent.threads.get(THREAD, ctx);
    expect(thread).not.toBeNull();
    expect(thread!.subject).toBe(SUBJECT);

    // 02 §4 (kill-list B3): everything the subject touched is an ordinary disk
    // row under its subject — threads, approvals, grants, and audit alike.
    expect(await env.count("vendo_threads", "subject = $1", [SUBJECT])).toBe(1);
    expect(await env.count("vendo_approvals", "subject = $1", [SUBJECT])).toBe(1);
    expect(await env.count("vendo_grants", "subject = $1", [SUBJECT])).toBe(1);
    expect(await env.count("vendo_audit", "subject = $1", [SUBJECT])).toBeGreaterThan(0);
    // The remembered grant is queryable in-session.
    expect(await env.guard.grants.list(ctx.principal)).toHaveLength(1);
  });
});
