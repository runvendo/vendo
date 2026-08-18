/** J5 — AWAY GRANT CAPTURE, FAIL-LOUD, RE-RUN, and REVOKE through the composed wire.
 *
 * The 07 §3 away-authority boundary, proven end-to-end on the composed system:
 *   1. A run whose steps reference two tools, one granted at capture and one
 *      DENIED, executes the granted step and FAILS LOUDLY on the ungranted one,
 *      naming the tool it needed: there is no waiting state left (07 §5).
 *   2. Deciding the captured ask over the wire mints an AUTOMATION-bound
 *      `source:"automation"` grant and RESUMES NOTHING — the failed run stays
 *      failed. The remedy is POST /runs/:id/rerun, a fresh run, and it is that
 *      run which lands the deferred host side effect.
 *   3. Revocation is live, and observably so: with the standing grant live THE LAW
 *      (§12) BLOCKS the away send over it; after DELETE /grants/:id there is no
 *      authority left at all, so the next fire fails loud asking for it. Two
 *      distinct outcomes across the revocation — now told apart by the run's
 *      error rather than its status — and the host is untouched either way.
 *   4. The 05 §6 boundary at the COMPOSED level: a chat-source grant (minted via a
 *      present chat approval with `remember`, so NO automation binding) never
 *      authorizes an away run — the automation fails loud instead.
 *
 * Nothing here polls. Park and resume are gone, so no run is ever finished by
 * something other than the call that started it: `vendo.emit` and POST
 * /runs/:id/rerun each await their run, so the wire is read ONCE, terminal. The
 * polls this file used to run also carried a 30s deadline of their own inside a
 * 120s test — a second, invisible speed limit that reported a product bug
 * whenever the machine was merely busy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
import {
  ADA,
  createAutomation,
  createStack,
  decideApprovals,
  hostFetch,
  readSseMidStream,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
  type WireApproval,
  type WireRun,
} from "../src/harness.js";

const LIST = "host_invoices_list";
const SEND = "host_invoices_send";
const UPDATE = "host_invoices_update";
const DELETE = "host_invoices_delete";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

/** A host-event automation as a RECORD. An automation carries no app reference,
 *  and a steps task reaches host tools by naming them right here. */
async function automationFor(
  event: string,
  steps: Array<{ id: string; tool: string; args?: Record<string, string> }>,
): Promise<string> {
  return (await createAutomation(stack, {
    owner: ADA,
    when: { event },
    task: { kind: "steps", steps },
  })).id;
}

async function enableMissing(automationId: string): Promise<WireApproval[]> {
  const enabled = (await (await stack.wireFetch(`/automations/${automationId}/enable`, { method: "POST" }, ADA)).json()) as {
    enabled: boolean;
    missing: WireApproval[];
  };
  expect(enabled.enabled).toBe(true);
  return enabled.missing;
}

/** The owner's pending approvals over the wire, narrowed to the away (run)
 *  ones — a still-pending capture ask for the same tool (presence "present")
 *  must never satisfy this lookup. */
async function pendingAway(tool: string): Promise<{ id: string } | undefined> {
  const pending = (await (await stack.wireFetch("/approvals", {}, ADA)).json()) as Array<{
    id: string;
    call: { tool: string };
    ctx?: { presence?: string; appId?: string };
  }>;
  return pending.find((request) => request.call.tool === tool && request.ctx?.presence === "away");
}

async function invoice(id: string): Promise<{ status: string; memo: string } | undefined> {
  const response = await hostFetch(`/api/invoices/${id}`, ADA.subject);
  if (response.status !== 200) return undefined;
  return ((await response.json()) as { invoice: { status: string; memo: string } }).invoice;
}

/** The run as the wire reports it — read once, never polled (see the header). */
async function readRun(runId: string): Promise<WireRun> {
  const response = await stack.wireFetch(`/runs/${runId}`, {}, ADA);
  expect(response.status).toBe(200);
  return (await response.json()) as WireRun;
}

/** The fail-loud remedy over the wire (POST /runs/:id/rerun): a FRESH run of the
 *  same automation on the same event, against live data. Returns its id. */
async function rerun(runId: string): Promise<string> {
  const response = await stack.wireFetch(`/runs/${runId}/rerun`, { method: "POST" }, ADA);
  expect(response.status).toBe(200);
  return ((await response.json()) as { runId: string }).runId;
}

describe("J5: away capture, fail-loud, re-run, revoke through the composed wire", () => {
  // The ungranted step is a non-destructive write (PATCH host_invoices_update),
  // not the send this file used to park on. THE LAW (§12) refuses a destructive
  // action in an unattended run no matter which grant is held, so with a send
  // here the re-run would be blocked by the law and this leg could no longer
  // show a decision buying real authority — the exact substitution S2 made in
  // `automations-e2e/fail-loud`. The law's own refusal is leg 3 below.
  it("fails loud on the ungranted step, mints an automation-bound grant on the decision, and the re-run lands the side effect", async () => {
    await resetFixture();
    stack = await createStack();
    const automationId = await automationFor("j5.miss", [
      { id: "list", tool: LIST },
      { id: "sweep", tool: UPDATE, args: { id: "event.id", memo: "'j5-swept'" } },
    ]);

    // Capture: approve list, DENY sweep — the run will hold a grant for one tool only.
    const missing = await enableMissing(automationId);
    const listId = missing.find((request) => request.call.tool === LIST)!.id;
    const sweepCaptureId = missing.find((request) => request.call.tool === UPDATE)!.id;
    expect((await decideApprovals(stack, [listId], { approve: true }, ADA)).status).toBe(200);
    expect((await decideApprovals(stack, [sweepCaptureId], { approve: false }, ADA)).status).toBe(200);

    const before = await invoice("inv_0003");
    expect(before?.memo).not.toBe("j5-swept");

    // Fire: the granted list runs, the ungranted sweep FAILS the run, loudly.
    const [runId] = await stack.vendo.emit("j5.miss", { id: "inv_0003" }, ADA);
    if (runId === undefined) throw new Error("emit did not return a run id");
    const failed = await readRun(runId);
    expect(failed).toMatchObject({ status: "error", error: { code: "needs-permission", tool: UPDATE } });
    expect(failed.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: "list", outcome: "ok" },
      { id: "sweep", outcome: "pending-approval" },
    ]);
    // Nothing swept yet.
    expect(await invoice("inv_0003")).toEqual(before);

    // The ask it failed on is an away approval owned by ADA, visible on the wire.
    const awaySweep = await pendingAway(UPDATE);
    expect(awaySweep).toBeDefined();
    // The ask carries no appId at all — a firing has no app. What binds it is
    // the RECORD, on the ctx's trigger, which is also the guard's away-grant key.
    const awayRows = await stack.sql<{
      venue: string;
      presence: string;
      app_id: string | null;
      automation_id: string | null;
    }>(
      `SELECT request->'ctx'->>'venue' AS venue,
              request->'ctx'->>'presence' AS presence,
              request->'ctx'->>'appId' AS app_id,
              request->'ctx'->'trigger'->>'automationId' AS automation_id
         FROM vendo_approvals WHERE id = $1`,
      [awaySweep!.id],
    );
    expect(awayRows).toEqual([
      { venue: "automation", presence: "away", app_id: null, automation_id: automationId },
    ]);

    // --- Decide approve over the wire → authority, not a resumption ---------
    expect((await decideApprovals(stack, [awaySweep!.id], { approve: true }, ADA)).status).toBe(200);
    // The decision minted an AUTOMATION-bound standing grant for the swept tool,
    // carrying no app_id: the grant belongs to the record the person was shown.
    expect(await stack.sql(
      "SELECT subject, tool, app_id, automation_id, source, duration FROM vendo_grants WHERE tool = $1 AND automation_id = $2",
      [UPDATE, automationId],
    )).toEqual([{
      subject: ADA.subject,
      tool: UPDATE,
      app_id: null,
      automation_id: automationId,
      source: "automation",
      duration: "standing",
    }]);
    // …and ran nothing: the failed run is still failed, the host still untouched.
    expect((await readRun(runId)).status).toBe("error");
    expect(await invoice("inv_0003")).toEqual(before);

    // --- Grant & re-run: a FRESH run over the wire does the deferred work ---
    const rerunId = await rerun(runId);
    expect(rerunId).not.toBe(runId);
    const reran = await readRun(rerunId);
    expect(reran.status).toBe("ok");
    expect(reran.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: "list", outcome: "ok" },
      { id: "sweep", outcome: "ok" },
    ]);
    // The deferred host side effect landed.
    expect((await invoice("inv_0003"))?.memo).toBe("j5-swept");
  });

  it("revocation is live: after DELETE /grants/:id the next run fails loud and the host is untouched", async () => {
    await resetFixture();
    stack = await createStack();
    const automationId = await automationFor("j5.revoke", [
      { id: "send", tool: SEND, args: { id: "event.id" } },
    ]);
    // Arming captures NOTHING for a destructive tool: a standing grant could
    // never authorize `host_invoices_send` away (THE LAW refuses it per fire),
    // so a card promising one would promise what no run honours. The way this
    // record comes to HOLD the grant this leg revokes is therefore the run's
    // own ask — the first fire meets a permission nobody granted, fails loud,
    // and the person answers THAT. Same standing, automation-bound,
    // automation-source grant leg 1 above pins; a different door to it.
    expect(await enableMissing(automationId)).toEqual([]);
    const [primingRun] = await stack.vendo.emit("j5.revoke", { id: "inv_0003" }, ADA);
    expect((await readRun(primingRun!)).error?.code).toBe("needs-permission");
    const sendAsk = await pendingAway(SEND);
    expect(sendAsk).toBeDefined();
    expect((await decideApprovals(stack, [sendAsk!.id], { approve: true }, ADA)).status).toBe(200);

    // The next run: the standing grant does NOT authorize the away send. THE LAW
    // (§12) "refuses a standing grant, rule, judge, or default authorizing an
    // irreversible action with nobody watching" — and `host_invoices_send` is
    // declared destructive (the dev's label is final; two-vote grading removed).
    // So the run is BLOCKED over a live grant, and the host is untouched.
    const [firstRun] = await stack.vendo.emit("j5.revoke", { id: "inv_0003" }, ADA);
    const blocked = await readRun(firstRun!);
    expect(blocked.status).toBe("error");
    expect(blocked.steps.at(-1)).toMatchObject({ tool: SEND, outcome: "blocked" });
    expect(blocked.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON);
    expect((await invoice("inv_0003"))?.status).toBe("draft");

    // Revoke the standing automation grant over the wire.
    const grants = (await (await stack.wireFetch("/grants", {}, ADA)).json()) as Array<{
      id: string;
      tool: string;
      automationId?: string;
    }>;
    const sendGrant = grants.find((grant) => grant.tool === SEND && grant.automationId === automationId);
    expect(sendGrant).toBeDefined();
    expect((await stack.wireFetch(`/grants/${sendGrant!.id}`, { method: "DELETE" }, ADA)).status).toBe(200);
    expect((await stack.sql<{ revoked_at: unknown }>(
      "SELECT revoked_at FROM vendo_grants WHERE id = $1",
      [sendGrant!.id],
    ))[0]?.revoked_at).toBeTruthy();

    // Next run fails LOUD, naming the tool — revocation disarmed nothing, the
    // run just asks again. A different refusal from the first fire's: the law
    // blocked a call it was authorized to make, this one holds no authority at
    // all. Both end the run; the error is what tells them apart.
    const before = await invoice("inv_0002");
    const [secondRun] = await stack.vendo.emit("j5.revoke", { id: "inv_0002" }, ADA);
    const failed = await readRun(secondRun!);
    expect(failed).toMatchObject({ status: "error", error: { code: "needs-permission", tool: SEND } });
    expect(failed.steps.at(-1)).toMatchObject({ tool: SEND, outcome: "pending-approval" });
    expect(await pendingAway(SEND)).toBeDefined();
    // The failed run never hit the host: the target invoice is unchanged.
    expect(await invoice("inv_0002")).toEqual(before);
  });

  it("a chat-source grant (no automation binding) never authorizes an away run — the automation fails loud (05 §6)", async () => {
    // The chat leg needs the scripted model: a destructive delete parks in chat,
    // approve+remember mints a STANDING chat grant with no appId binding.
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn(DELETE, { id: "inv_0003" }, "call_1"),
        textTurn("Deleted the invoice.", "t1"),
      ],
    });

    // --- Mint a chat-source, un-app-bound grant for DELETE ----------------
    // Build contract §1.4: the guarded call blocks INSIDE the tool call
    // awaiting the tap, holding this one request open — decide against the
    // still-open stream rather than a later, separately-posted resume.
    const paused = readSseMidStream(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_j5",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "Delete invoice inv_0003" }] },
        }),
      }, ADA),
    );
    // Build contract §1.5: tool calls are mirrored by the RUNTIME on its own
    // freshly-minted id — never the scripted model's own toolCallId ("call_1"
    // only ever reached the wire under `createAgent`'s direct ai-SDK
    // pass-through), so the check here is that the card carries ONE, not that
    // literal value.
    const approvalCard = await paused.approval;
    expect(typeof approvalCard.toolCallId).toBe("string");
    const approvalId = approvalCard.approvalId;
    if (approvalId === undefined) throw new Error("approval card carried no approvalId");
    expect((await decideApprovals(
      stack,
      [approvalId],
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      ADA,
    )).status).toBe(200);
    await paused.done;
    // The minted chat grant is standing and carries NO appId (05 §6 preconditions).
    expect(await stack.sql<{ source: string; app_id: string | null; duration: string }>(
      "SELECT source, app_id, duration FROM vendo_grants WHERE tool = $1",
      [DELETE],
    )).toEqual([{ source: "chat", app_id: null, duration: "standing" }]);

    // --- The automation references the same tool, and arming grants it nothing --
    // `host_invoices_delete` is destructive, so arming captures nothing for it:
    // a standing grant could never authorize it away, and a card promising one
    // would promise what no firing honours. The record therefore arms holding
    // no automation authority at all — which is exactly the state this leg
    // needs, and it arrives without anyone having to refuse anything.
    const automationId = await automationFor("j5.chatgrant", [
      { id: "delete", tool: DELETE, args: { id: "event.id" } },
    ]);
    expect(await enableMissing(automationId)).toEqual([]);

    // --- Fire: the away run fails loud; the chat grant does not carry across --
    expect(await invoice("inv_0002")).toBeDefined(); // exists before
    const [runId] = await stack.vendo.emit("j5.chatgrant", { id: "inv_0002" }, ADA);
    const failed = await readRun(runId!);
    expect(failed).toMatchObject({ status: "error", error: { code: "needs-permission", tool: DELETE } });
    expect(failed.steps.at(-1)).toMatchObject({ tool: DELETE, outcome: "pending-approval" });
    const away = await pendingAway(DELETE);
    expect(away).toBeDefined();
    expect((await stack.sql<{ presence: string; automation_id: string | null }>(
      `SELECT request->'ctx'->>'presence' AS presence,
              request->'ctx'->'trigger'->>'automationId' AS automation_id
         FROM vendo_approvals WHERE id = $1`,
      [away!.id],
    ))).toEqual([{ presence: "away", automation_id: automationId }]);
    // Host untouched: the chat-granted delete never ran away.
    expect(await invoice("inv_0002")).toBeDefined();
  });
});
