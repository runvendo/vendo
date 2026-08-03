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
 *
 * The grant ladder above runs on a NON-destructive write, because THE LAW
 * (design §12) means a destructive-or-external tool never enters an away run at
 * all — there is no park to reach. The law's own behaviour is the last scenario
 * here: `host_invoices_send` in an away run is unprojected and refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolvedRisk, UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
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

/** The park/grant-authorization scenarios below need a tool an automation is
 *  ALLOWED to run unattended, because their subject is the grant ladder, not the
 *  law. THE LAW (design §12) is why this is an `update` and not a `send`: a
 *  destructive-or-external tool is never projected into an away run at all, so
 *  it can never reach the park path this exercises. `host_invoices_send` gets
 *  its own scenario at the bottom of this file — that refusal is E2(e) coverage,
 *  not a gap. */
const TOOL = "host_invoices_update";
const update = descriptor({ name: TOOL, risk: "write" });

/** The external tool the law forbids unattended — `send` reaches a human. */
const EXTERNAL_TOOL = "host_invoices_send";
const send = descriptor({ name: EXTERNAL_TOOL, risk: "write" });

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

    // The scenario is only about the grant ladder if the tool is one an
    // automation may legally run unattended. Pin that with the REAL resolution,
    // so renaming this tool to something destructive fails here loudly instead
    // of silently turning the scenario into a law test.
    expect(resolvedRisk(update)).toBe("write");

    // --- Away run #1: ungranted write parks, fails soft ---------------------
    const reg1 = new SpyRegistry([update], { [TOOL]: { updated: 1 } });
    const report1 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_1" }, "c1"), textTurn("Parked.", "t1")]),
      reg1,
      awayCtx("run_1"),
      "Update invoice 1",
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
    const reg2 = new SpyRegistry([update], { [TOOL]: { updated: 2 } });
    const report2 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_2" }, "c2"), textTurn("Parked again.", "t2")]),
      reg2,
      awayCtx("run_2"),
      "Update invoice 2",
    );
    expect(report2.toolCalls).toEqual([
      expect.objectContaining({ outcome: "pending-approval" }),
    ]);
    expect(reg2.count(TOOL)).toBe(0); // still parks — chat-minted grants never authorize away

    // --- Seed the automation-source app-bound grant enable-capture mints ----
    await seedGrant(env.store, {
      subject: SUBJECT,
      descriptor: update,
      appId: APP_ID,
      source: "automation",
      scope: { kind: "tool" },
      duration: "standing",
    });

    // --- Away run #3: now it runs without asking ----------------------------
    const pendingBefore = await env.count("vendo_approvals", "status = 'pending'");
    const reg3 = new SpyRegistry([update], { [TOOL]: { updated: 3 } });
    const report3 = await runAway(
      scriptedModel([toolCallTurn(TOOL, { invoiceId: "inv_3" }, "c3"), textTurn("Updated.", "t3")]),
      reg3,
      awayCtx("run_3"),
      "Update invoice 3",
    );
    expect(report3.toolCalls).toEqual([expect.objectContaining({ outcome: "ok" })]);
    expect(reg3.count(TOOL)).toBe(1);
    // No new approval parked.
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(pendingBefore);
  });

  it("a chat grant with no appId does not authorize an away run either", async () => {
    env = await createEnv();
    // Also a non-destructive write, and for the same reason as `update` above:
    // an unattended run never sees a destructive-or-external tool, so only a
    // legally-projectable write can prove anything about the GRANT rule.
    const toolB = descriptor({ name: "host_reports_write", risk: "write" });
    expect(resolvedRisk(toolB)).toBe("write");
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
      scriptedModel([toolCallTurn(toolB.name, { reportId: "rep_1" }, "cb"), textTurn("Parked.", "tb")]),
      reg,
      awayCtx("run_b"),
      "Write up the report",
    );

    expect(report.toolCalls).toEqual([expect.objectContaining({ outcome: "pending-approval" })]);
    expect(reg.count(toolB.name)).toBe(0);
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(1);
  });

  /** THE LAW (design §12): destructive AND EXTERNAL actions are never
   *  unattended. `host_invoices_send` sends invoices TO PEOPLE, so it resolves
   *  destructive (declared `write`, but the second mechanical vote reads `send`
   *  and disagreement resolves against the tool) and is refused in an away run.
   *
   *  This is the behaviour that replaced this file's old park expectation, and it
   *  is the E2(e) property worth pinning: not with a limit, not with a
   *  condition, not with the strongest grant that exists. */
  it("refuses an external tool in an away run — never projected, never executed (THE LAW, §12)", async () => {
    env = await createEnv();

    // The declared label is the permissive one; the mechanical vote overrules it.
    expect(send.risk).toBe("write");
    expect(resolvedRisk(send)).toBe("destructive");

    // The strongest authority that exists today: standing, app-bound, minted by
    // automation enable-capture. The law must beat it.
    await seedGrant(env.store, {
      subject: SUBJECT,
      descriptor: send,
      appId: APP_ID,
      source: "automation",
      scope: { kind: "tool" },
      duration: "standing",
    });

    const reg = new SpyRegistry([send], { [EXTERNAL_TOOL]: { sent: 1 } });

    // 1. Not projected: the model in an away run is never even offered it.
    const projected = await env
      .bound(reg)
      .descriptors({ venue: "automation", presence: "away" });
    expect(projected.map((d) => d.name)).toEqual([]);

    // 2. Refused at the guard if reached anyway (defence in depth), with the
    //    law's own reason — the one a harness maps to `unattended-destructive`.
    const outcome = await env.bound(reg).execute(
      { id: "cx", tool: EXTERNAL_TOOL, args: { invoiceId: "inv_1" } },
      awayCtx("run_law"),
    );
    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });

    // 3. It never ran, and no approval was parked to make it look pending.
    expect(reg.count(EXTERNAL_TOOL)).toBe(0);
    expect(await env.count("vendo_approvals", "status = 'pending'")).toBe(0);

    // 4. The refusal is on the record, so a run history can explain itself.
    expect(
      await env.count("vendo_audit", "event->>'tool' = $1 AND event->>'outcome' = 'blocked'", [
        EXTERNAL_TOOL,
      ]),
    ).toBe(1);
  });

  it("still lets the SAME external tool run when a person is present — a normal confirm (§12)", async () => {
    // The law withholds unattended irreversibility, not the capability. Without
    // this, "refused in an away run" could be satisfied by a tool that is simply
    // broken everywhere.
    env = await createEnv();
    await seedGrant(env.store, {
      subject: SUBJECT,
      descriptor: send,
      scope: { kind: "tool" },
      duration: "standing",
    });
    const reg = new SpyRegistry([send], { [EXTERNAL_TOOL]: { sent: 1 } });

    const outcome = await env.bound(reg).execute(
      { id: "cy", tool: EXTERNAL_TOOL, args: { invoiceId: "inv_1" } },
      userCtx(SUBJECT, { venue: "chat", presence: "present" }),
    );

    expect(outcome.status).toBe("ok");
    expect(reg.count(EXTERNAL_TOOL)).toBe(1);
  });
});
