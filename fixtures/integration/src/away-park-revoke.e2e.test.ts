/** J5 — AWAY GRANT CAPTURE, PARK, RESUME, and REVOKE through the composed wire.
 *
 * The 07 §3 away-authority boundary, proven end-to-end on the composed system:
 *   1. A run whose steps reference two tools, one granted at capture and one
 *      DENIED, executes the granted step and PARKS on the ungranted one.
 *   2. Deciding the parked approval over the wire RESUMES the run
 *      (guard.onApprovalDecision through the umbrella) to "ok"; the deferred host
 *      side effect lands and an app-bound `source:"automation"` grant is minted.
 *   3. Revocation is live, and observably so: with the standing grant live THE LAW
 *      (§12) BLOCKS the away send over it; after DELETE /grants/:id there is no
 *      authority left at all, so the next fire PARKS to ask a human. Two distinct
 *      outcomes across the revocation, and the host is untouched either way.
 *   4. The 05 §6 boundary at the COMPOSED level: a chat-source grant (minted via a
 *      present chat approval with `remember`, so NO appId binding) never authorizes
 *      an away run — the automation still parks.
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
  waitForRunStatus,
  type Stack,
  type WireApproval,
} from "./harness.js";

const LIST = "host_invoices_list";
const SEND = "host_invoices_send";
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
    trigger: { on: { kind: "host-event", event }, run: { kind: "steps", steps } },
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

async function invoiceStatus(id: string): Promise<string | undefined> {
  const response = await hostFetch(`/api/invoices/${id}`, ADA.subject);
  if (response.status !== 200) return undefined;
  return ((await response.json()) as { invoice: { status: string } }).invoice.status;
}

describe("J5: away capture, park, resume, revoke through the composed wire", () => {
  it("parks the ungranted step, resumes on a wire decision, mints an app-bound grant, lands the side effect", async () => {
    await resetFixture();
    stack = await createStack();
    const imported = await importAutomation(
      stack,
      stepsAutomation("j5.park", [
        { id: "list", tool: LIST },
        { id: "send", tool: SEND, args: { id: "event.id" } },
      ]),
      ADA,
    );
    const appId = imported.id;

    // Capture: approve list, DENY send — the run will hold a grant for one tool only.
    const missing = await enableMissing(appId);
    const listId = missing.find((request) => request.call.tool === LIST)!.id;
    const sendCaptureId = missing.find((request) => request.call.tool === SEND)!.id;
    expect((await decideApprovals(stack, [listId], { approve: true }, ADA)).status).toBe(200);
    expect((await decideApprovals(stack, [sendCaptureId], { approve: false }, ADA)).status).toBe(200);

    expect(await invoiceStatus("inv_0003")).toBe("draft");

    // Fire: the granted list runs, the ungranted send PARKS the run.
    const [runId] = await stack.vendo.emit("j5.park", { id: "inv_0003" }, ADA);
    if (runId === undefined) throw new Error("emit did not return a run id");
    const parked = await waitForRunStatus(stack, runId, ADA, "pending-approval");
    expect(parked.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: "list", outcome: "ok" },
      { id: "send", outcome: "pending-approval" },
    ]);
    // Nothing sent yet.
    expect(await invoiceStatus("inv_0003")).toBe("draft");

    // The parked approval is an away approval owned by ADA, visible on the wire.
    const awaySend = await pendingAway(SEND);
    expect(awaySend).toBeDefined();
    const awayRows = await stack.sql<{ venue: string; presence: string; app_id: string | null }>(
      `SELECT request->'ctx'->>'venue' AS venue,
              request->'ctx'->>'presence' AS presence,
              request->'ctx'->>'appId' AS app_id
         FROM vendo_approvals WHERE id = $1`,
      [awaySend!.id],
    );
    expect(awayRows).toEqual([{ venue: "automation", presence: "away", app_id: appId }]);

    // --- Resume: decide approve over the wire → the run finishes for real ---
    expect((await decideApprovals(stack, [awaySend!.id], { approve: true }, ADA)).status).toBe(200);
    const resumed = await waitForRunStatus(stack, runId, ADA, "ok");
    expect(resumed.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: "list", outcome: "ok" },
      { id: "send", outcome: "ok" },
    ]);
    // The deferred host side effect landed.
    expect(await invoiceStatus("inv_0003")).toBe("open");

    // The resumption minted an app-bound automation grant for the send tool.
    expect(await stack.sql(
      "SELECT subject, tool, app_id, source, duration FROM vendo_grants WHERE tool = $1 AND app_id = $2",
      [SEND, appId],
    )).toEqual([
      { subject: ADA.subject, tool: SEND, app_id: appId, source: "automation", duration: "standing" },
    ]);
  });

  it("revocation is live: after DELETE /grants/:id the next run parks and the host is untouched", async () => {
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
    // irreversible action with nobody watching" — and `host_invoices_send`
    // resolves destructive on the second mechanical vote whatever its declared
    // label. So the run is BLOCKED over a live grant, and the host is untouched.
    const [firstRun] = await stack.vendo.emit("j5.revoke", { id: "inv_0003" }, ADA);
    const blocked = await waitForRunStatus(stack, firstRun!, ADA, "error");
    expect(blocked.steps.at(-1)).toMatchObject({ tool: SEND, outcome: "blocked" });
    expect(blocked.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON);
    expect(await invoiceStatus("inv_0003")).toBe("draft");

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

    // Next run parks — revocation disarmed nothing, the run just asks again.
    const before = await invoiceStatus("inv_0002");
    const [secondRun] = await stack.vendo.emit("j5.revoke", { id: "inv_0002" }, ADA);
    const parked = await waitForRunStatus(stack, secondRun!, ADA, "pending-approval");
    expect(parked.steps.at(-1)).toMatchObject({ tool: SEND, outcome: "pending-approval" });
    expect(await pendingAway(SEND)).toBeDefined();
    // The parked run never hit the host: the target invoice is unchanged.
    expect(await invoiceStatus("inv_0002")).toBe(before);
  });

  it("a chat-source grant (no appId) never authorizes an away run — the automation still parks (05 §6)", async () => {
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
      enabled: boolean;
    }>;
    expect(listed.find((entry) => entry.app.id === appId)?.enabled).toBe(false);

    // Re-arm; the re-minted capture ask stays UNDECIDED — an open ask leaves
    // the automation armed and the ungranted step parks at fire time, the
    // moment this leg actually exercises.
    await enableMissing(appId);

    // --- Fire: the away run parks; the chat grant does not carry across -----
    expect(await invoiceStatus("inv_0002")).toBeDefined(); // exists before
    const [runId] = await stack.vendo.emit("j5.chatgrant", { id: "inv_0002" }, ADA);
    const parked = await waitForRunStatus(stack, runId!, ADA, "pending-approval");
    expect(parked.steps.at(-1)).toMatchObject({ tool: DELETE, outcome: "pending-approval" });
    const away = await pendingAway(DELETE);
    expect(away).toBeDefined();
    expect((await stack.sql<{ presence: string; app_id: string | null }>(
      `SELECT request->'ctx'->>'presence' AS presence, request->'ctx'->>'appId' AS app_id
         FROM vendo_approvals WHERE id = $1`,
      [away!.id],
    ))).toEqual([{ presence: "away", app_id: appId }]);
    // Host untouched: the chat-granted delete never ran away.
    expect(await invoiceStatus("inv_0002")).toBeDefined();
  });
});
