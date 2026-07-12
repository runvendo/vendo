/** Scenario 4 — GRANT DRIFT ACROSS THE CHAT PATH.
 *
 * A standing grant is minted for a tool. When the tool's descriptor drifts
 * (its risk changes → its descriptorHash changes), the grant no longer matches
 * — so the same call asks again. The lapse is observed through the full agent
 * stream (needsApproval → guard), not the guard in isolation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { descriptorHash } from "@vendoai/core";
import {
  createEnv,
  descriptor,
  partsOfType,
  readSse,
  scriptedModel,
  SpyRegistry,
  textTurn,
  toolCallTurn,
  userCtx,
  userMessage,
  vendoApprovalId,
  type Env,
} from "./harness.js";

const SUBJECT = "user_drift";
const TOOL = "host_widget_update";
// Same name; the risk (and therefore the descriptorHash) drifts read→destructive.
const d1 = descriptor({ name: TOOL, risk: "write" });
const d2 = descriptor({ name: TOOL, risk: "destructive" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 4: grant drift across the chat path", () => {
  it("mints a standing grant, honors it, then asks again once the descriptor drifts", async () => {
    env = await createEnv({ policy: { rules: [{ match: { tool: TOOL }, action: "ask" }] } });

    // --- Mint a standing tool-scope grant (park + decide remember) ----------
    const registry1 = new SpyRegistry([d1], { [TOOL]: { ok: 1 } });
    const model1 = scriptedModel([
      toolCallTurn(TOOL, { id: "w1" }, "call_1"), // stream #1: parks
      toolCallTurn(TOOL, { id: "w2" }, "call_2"), // stream #2: runs via grant
      textTurn("Updated.", "t1"), //                stream #2 continues
    ]);
    const agent1 = env.agentFor(registry1, model1);
    const ctx = userCtx(SUBJECT);

    const paused = await readSse(
      await agent1.stream({ threadId: "thr_drift", message: userMessage("u1", "Update w1"), ctx }),
    );
    await env.guard.approvals.decide(
      vendoApprovalId(paused),
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      ctx.principal,
    );

    const grants = await env.sql<{ descriptor_hash: string }>("SELECT descriptor_hash FROM vendo_grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.descriptor_hash).toBe(descriptorHash(d1));

    // --- The grant authorizes a fresh call while the descriptor is stable ---
    const stable = await readSse(
      await agent1.stream({ threadId: "thr_drift", message: userMessage("u2", "Update w2"), ctx }),
    );
    expect(partsOfType(stable, "tool-approval-request")).toHaveLength(0);
    expect(registry1.count(TOOL)).toBe(1);

    // --- Drift: re-bind a registry whose descriptor changed risk -----------
    const registry2 = new SpyRegistry([d2], { [TOOL]: { ok: 2 } });
    const model2 = scriptedModel([toolCallTurn(TOOL, { id: "w3" }, "call_3")]);
    const agent2 = env.agentFor(registry2, model2);

    const drifted = await readSse(
      await agent2.stream({ threadId: "thr_drift2", message: userMessage("u3", "Update w3"), ctx }),
    );

    // The drifted descriptor no longer matches the grant → it asks again,
    // observed through the full agent stream, and nothing executed.
    expect(partsOfType(drifted, "tool-approval-request")).toHaveLength(1);
    expect(registry2.count(TOOL)).toBe(0);
    const stillPending = await env.guard.approvals.pending(ctx.principal);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.descriptor.risk).toBe("destructive");
  });
});
