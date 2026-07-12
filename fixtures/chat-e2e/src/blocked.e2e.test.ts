/** Scenario 3 — BLOCKED, TOLD TO THE MODEL.
 *
 * A real policy rule blocks a tool. The block is never silently swallowed: the
 * blocked outcome (with its reason) reaches the model's next-step prompt, and
 * the audit trail records a policy-decision decidedBy the rule with outcome
 * "blocked".
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  createEnv,
  descriptor,
  readSse,
  scriptedModel,
  SpyRegistry,
  textTurn,
  toolCallTurn,
  userCtx,
  userMessage,
  type Env,
} from "./harness.js";

const SUBJECT = "user_block";
const THREAD = "thr_block";
const TOOL = "host_payouts_wire";
const REASON = "wires are disabled for this workspace";
const wire = descriptor({ name: TOOL, risk: "destructive" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 3: blocked told to the model", () => {
  it("tells the model the block reason and audits a policy-decision blocked by rule", async () => {
    env = await createEnv({
      policy: { rules: [{ match: { tool: TOOL }, action: "block", note: REASON }] },
    });
    const registry = new SpyRegistry([wire]);
    const model = scriptedModel([
      toolCallTurn(TOOL, { amountCents: 1000 }, "call_1"),
      textTurn("That action is blocked, so I stopped.", "t1"),
    ]);
    const agent = env.agentFor(registry, model);
    const ctx = userCtx(SUBJECT);

    await readSse(
      await agent.stream({ threadId: THREAD, message: userMessage("u1", "Wire the payout"), ctx }),
    );

    // Never executed.
    expect(registry.count(TOOL)).toBe(0);

    // The blocked outcome — carrying the reason — reached the model's next
    // prompt. The scripted model records each prompt it was handed; the second
    // one is the continuation after the tool returned blocked.
    expect(model.prompts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(model.prompts)).toContain(REASON);

    // SQL: a policy-decision audit event, decidedBy the rule, outcome blocked.
    const events = await auditEvents(env, SUBJECT);
    const blocked = events.filter(
      (event) => event.kind === "policy-decision" && event.outcome === "blocked",
    );
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0]).toMatchObject({ tool: TOOL, decidedBy: "rule", outcome: "blocked" });
    // And the executed-path tool-call event also records the blocked outcome.
    expect(events.some((event) => event.kind === "tool-call" && event.outcome === "blocked")).toBe(true);
  });
});
