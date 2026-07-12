/** Scenario 6 — AWAY RUNNER PARK + RESUME, and the 05 §6 boundary.
 *
 * agent.asRunner() runs the same loop with presence "away": an ungranted write
 * parks as pending-approval and the run fails soft (it does not throw). The
 * scenario then pins the exact 05 §6 rule through the full runner stream:
 *
 *   - A grant minted by deciding a chat/away approval (ApprovalDecision.remember
 *     → source "chat", core §5) is appId-bound but does NOT authorize away
 *     execution — away runs hold only "automation"-source, app-bound grants
 *     (05 §6). So a subsequent away run still parks.
 *   - A source "automation", app-bound grant (what automation enable-capture
 *     mints, 07 §3) DOES authorize the away run — it then succeeds without asking.
 *   - A chat grant with no appId never authorizes an away run either.
 *
 * (The happy "decide → next away firing runs" path is the automations block's
 * enable-capture, covered by fixtures/automations-e2e; deciding a parked
 * approval here mints source "chat" by contract, which is deliberately
 * insufficient for away — that is the property this scenario verifies.)
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunReport, RunContext, ToolRegistry } from "@vendoai/core";
import type { LanguageModel } from "ai";
import {
  createEnv,
  descriptor,
  scriptedModel,
  seedGrant,
  SpyRegistry,
  textTurn,
  toolCallTurn,
  userCtx,
  type Env,
} from "./harness.js";

const SUBJECT = "user_away";
const APP_ID = "app_auto";
const TOOL = "host_invoices_send";
const send = descriptor({ name: TOOL, risk: "write" });

let env: Env;
afterEach(async () => {
  await env?.close();
});

function awayCtx(runId: string): RunContext {
  return userCtx(SUBJECT, {
    venue: "automation",
    presence: "away",
    appId: APP_ID,
    trigger: { runId, kind: "schedule" },
  });
}

async function runAway(
  model: LanguageModel,
  registry: ToolRegistry,
  ctx: RunContext,
  prompt: string,
): Promise<AgentRunReport> {
  const runner = env.agentFor(registry, model).asRunner();
  return runner({ prompt, tools: env.bound(registry), budget: { maxToolCalls: 4 } }, ctx);
}

describe("scenario 6: away runner park + resume (05 §6)", () => {
  it("parks an ungranted away write (fails soft), and only an automation-source app-bound grant authorizes the next away run", async () => {
    env = await createEnv();

    // --- Away run #1: ungranted write parks, fails soft ---------------------
    const reg1 = new SpyRegistry([send], { [TOOL]: { sent: 1 } });
    const report1 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_1" }, "c1"), textTurn("Parked.", "t1")]),
      reg1,
      awayCtx("run_1"),
      "Send invoice 1",
    );
    expect(["ok", "stopped"]).toContain(report1.status); // no throw — fails soft
    expect(report1.toolCalls).toEqual([
      expect.objectContaining({ outcome: "pending-approval" }),
    ]);
    expect(reg1.count(TOOL)).toBe(0);
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(1);

    // --- Decide with remember → source "chat", app-bound (core §5) ----------
    const parked = await env.guard.approvals.pending({ kind: "user", subject: SUBJECT });
    expect(parked).toHaveLength(1);
    await env.guard.approvals.decide(
      parked[0]!.id,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      { kind: "user", subject: SUBJECT },
    );
    const chatGrant = await env.sql<{ source: string; app_id: string | null }>(
      "SELECT source, app_id FROM vendo_grants",
    );
    expect(chatGrant).toEqual([{ source: "chat", app_id: APP_ID }]);

    // --- Away run #2: the chat grant does NOT authorize away (05 §6) --------
    const reg2 = new SpyRegistry([send], { [TOOL]: { sent: 2 } });
    const report2 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_2" }, "c2"), textTurn("Parked again.", "t2")]),
      reg2,
      awayCtx("run_2"),
      "Send invoice 2",
    );
    expect(report2.toolCalls).toEqual([
      expect.objectContaining({ outcome: "pending-approval" }),
    ]);
    expect(reg2.count(TOOL)).toBe(0); // still parks — chat-minted grants never authorize away

    // --- Seed the automation-source app-bound grant enable-capture mints ----
    await seedGrant(env.store, {
      subject: SUBJECT,
      descriptor: send,
      appId: APP_ID,
      source: "automation",
      scope: { kind: "tool" },
      duration: "standing",
    });

    // --- Away run #3: now it runs without asking ----------------------------
    const pendingBefore = await env.count("vendo_approvals", "status = 'pending'");
    const reg3 = new SpyRegistry([send], { [TOOL]: { sent: 3 } });
    const report3 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_3" }, "c3"), textTurn("Sent.", "t3")]),
      reg3,
      awayCtx("run_3"),
      "Send invoice 3",
    );
    expect(report3.toolCalls).toEqual([expect.objectContaining({ outcome: "ok" })]);
    expect(reg3.count(TOOL)).toBe(1);
    // No new approval parked.
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(pendingBefore);
  });

  it("a chat grant with no appId does not authorize an away run either", async () => {
    env = await createEnv();
    const toolB = descriptor({ name: "host_reports_email", risk: "write" });
    // A present-chat standing grant, no appId — the ordinary chat grant shape.
    await seedGrant(env.store, {
      subject: SUBJECT,
      descriptor: toolB,
      source: "chat",
      scope: { kind: "tool" },
      duration: "standing",
    });

    const reg = new SpyRegistry([toolB], { [toolB.name]: { ok: true } });
    const report = await runAway(
      scriptedModel([toolCallTurn(toolB.name, { to: "a@b.co" }, "cb"), textTurn("Parked.", "tb")]),
      reg,
      awayCtx("run_b"),
      "Email the report",
    );

    expect(report.toolCalls).toEqual([expect.objectContaining({ outcome: "pending-approval" })]);
    expect(reg.count(toolB.name)).toBe(0);
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(1);
  });
});
