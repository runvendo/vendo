/** J5 — AWAY GRANT CAPTURE, FAIL-LOUD, RE-RUN, and REVOKE through the composed wire.
 *
 * The 07 §3 away-authority boundary, proven end-to-end on the composed system:
 *   1. A run whose steps reference two tools, one granted at capture and one
 *      DENIED, executes the granted step and FAILS LOUDLY on the ungranted one,
 *      naming the tool it needed: there is no waiting state left (07 §5).
 *   2. Deciding the captured ask over the wire mints an app-bound
 *      `source:"automation"` grant and RESUMES NOTHING — the failed run stays
 *      failed. The remedy is POST /runs/:id/rerun, a fresh run, and it is that
 *      run which lands the deferred host side effect.
 *   3. Revocation is live, and observably so: with the standing grant live THE LAW
 *      (§12) BLOCKS the away send over it; after DELETE /grants/:id there is no
 *      authority left at all, so the next fire fails loud asking for it. Two
 *      distinct outcomes across the revocation — now told apart by the run's
 *      error rather than its status — and the host is untouched either way.
 *   4. The 05 §6 boundary at the COMPOSED level: a chat-source grant (minted via a
 *      present chat approval with `remember`, so NO appId binding) never authorizes
 *      an away run — the automation fails loud instead.
 *
 * Nothing here polls. Park and resume are gone, so no run is ever finished by
 * something other than the call that started it: `vendo.emit` and POST
 * /runs/:id/rerun each await their run, so the wire is read ONCE, terminal. The
 * polls this file used to run also carried a 30s deadline of their own inside a
 * 120s test — a second, invisible speed limit that reported a product bug
 * whenever the machine was merely busy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { UNATTENDED_DESTRUCTIVE_REASON, type AppDocument } from "@vendoai/core";
import {
  ADA,
  createStack,
  decideApprovals,
  hostFetch,
  importAutomation,
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

function stepsAutomation(event: string, steps: Array<{ id: string; tool: string; args?: Record<string, string> }>): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_import_placeholder",
    name: "J5 automation",
    triggers: [{ id: "main", on: { kind: "host-event", event }, run: { kind: "steps", steps } }],
  };
}

async function enableMissing(appId: string): Promise<WireApproval[]> {
  const enabled = (await (await stack.wireFetch(`/automations/${appId}/enable`, { method: "POST" }, ADA)).json()) as {
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
 *  same trigger on the same event, against live data. Returns its id. */
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
  it("fails loud on the ungranted step, mints an app-bound grant on the decision, and the re-run lands the side effect", async () => {
    await resetFixture();
    stack = await createStack();
    const imported = await importAutomation(
      stack,
      stepsAutomation("j5.miss", [
        { id: "list", tool: LIST },
        { id: "sweep", tool: UPDATE, args: { id: "event.id", memo: "'j5-swept'" } },
      ]),
      ADA,
    );
    const appId = imported.id;

    // Capture: approve list, DENY sweep — the run will hold a grant for one tool only.
    const missing = await enableMissing(appId);
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
    const awayRows = await stack.sql<{ venue: string; presence: string; app_id: string | null }>(
      `SELECT request->'ctx'->>'venue' AS venue,
              request->'ctx'->>'presence' AS presence,
              request->'ctx'->>'appId' AS app_id
         FROM vendo_approvals WHERE id = $1`,
      [awaySweep!.id],
    );
    expect(awayRows).toEqual([{ venue: "automation", presence: "away", app_id: appId }]);

    // --- Decide approve over the wire → authority, not a resumption ---------
    expect((await decideApprovals(stack, [awaySweep!.id], { approve: true }, ADA)).status).toBe(200);
    // The decision minted an app-bound automation grant for the swept tool…
    expect(await stack.sql(
      "SELECT subject, tool, app_id, source, duration FROM vendo_grants WHERE tool = $1 AND app_id = $2",
      [UPDATE, appId],
    )).toEqual([
      { subject: ADA.subject, tool: UPDATE, app_id: appId, source: "automation", duration: "standing" },
    ]);
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
    const imported = await importAutomation(
      stack,
      stepsAutomation("j5.revoke", [{ id: "send", tool: SEND, args: { id: "event.id" } }]),
      ADA,
    );
    const appId = imported.id;
    const missing = await enableMissing(appId);
    expect((await decideApprovals(stack, missing.map((request) => request.id), { approve: true }, ADA)).status).toBe(200);

    // First run: the standing grant does NOT authorize the away send. THE LAW
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
      appId?: string;
    }>;
    const sendGrant = grants.find((grant) => grant.tool === SEND && grant.appId === appId);
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

  it("a chat-source grant (no appId) never authorizes an away run — the automation fails loud (05 §6)", async () => {
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

    // --- The automation references the same tool; deny its capture --------
    const imported = await importAutomation(
      stack,
      stepsAutomation("j5.chatgrant", [{ id: "delete", tool: DELETE, args: { id: "event.id" } }]),
      ADA,
    );
    const appId = imported.id;
    const missing = await enableMissing(appId);
    expect((await decideApprovals(stack, missing.map((request) => request.id), { approve: false }, ADA)).status).toBe(200);

    // Grant sets (demo-live-readiness): a consent moment refused WHOLESALE
    // (every capture denied, nothing granted) disarms the automation in the
    // same decision — the row must not sit enabled-but-ungranted.
    const listed = (await (await stack.wireFetch("/automations", {}, ADA)).json()) as Array<{
      app: { id: string };
      triggers: Array<{ enabled: boolean }>;
    }>;
    expect(listed.find((entry) => entry.app.id === appId)?.triggers[0]?.enabled).toBe(false);

    // Re-arm; the re-minted capture ask stays UNDECIDED — an open ask leaves
    // the automation armed and the ungranted step fails loud at fire time, the
    // moment this leg actually exercises.
    await enableMissing(appId);

    // --- Fire: the away run fails loud; the chat grant does not carry across --
    expect(await invoice("inv_0002")).toBeDefined(); // exists before
    const [runId] = await stack.vendo.emit("j5.chatgrant", { id: "inv_0002" }, ADA);
    const failed = await readRun(runId!);
    expect(failed).toMatchObject({ status: "error", error: { code: "needs-permission", tool: DELETE } });
    expect(failed.steps.at(-1)).toMatchObject({ tool: DELETE, outcome: "pending-approval" });
    const away = await pendingAway(DELETE);
    expect(away).toBeDefined();
    expect((await stack.sql<{ presence: string; app_id: string | null }>(
      `SELECT request->'ctx'->>'presence' AS presence, request->'ctx'->>'appId' AS app_id
         FROM vendo_approvals WHERE id = $1`,
      [away!.id],
    ))).toEqual([{ presence: "away", app_id: appId }]);
    // Host untouched: the chat-granted delete never ran away.
    expect(await invoice("inv_0002")).toBeDefined();
  });
});
