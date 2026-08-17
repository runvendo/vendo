/** J4 — AUTOMATION LIFECYCLE through the composed wire.
 *
 * An automation is a RECORD now, not an app carrying a trigger, and there is
 * deliberately no public create — so a journey that needs one specific record
 * reaches the ONE create operation every authoring door shares
 * (`automationsInternals(engine).create`, off the composed umbrella's own
 * engine). Everything after that is the PUBLIC wire, which is what this journey
 * is about: POST /automations/:id/enable and its grant-capture flow, deciding
 * the asks over /approvals/decide (SQL then proves standing,
 * automation-bound, `source:"automation"` grants), GET /automations,
 * POST /automations/:id/dry-run, GET /runs, and POST /automations/:id/disable.
 *
 * All three PUBLIC ways a firing is woken are driven:
 *   (a) schedule — a due `at` + POST /tick with the bearer secret;
 *   (b) host-event — `vendo.emit(event, payload, ADA)`;
 *   (c) Cloud's heartbeat — the SAME /tick door, reached with a standard-webhooks
 *       signature instead of the bearer, which is the only credential Cloud has.
 * Each away run executes its steps against the REAL host app through `actAs`,
 * so the created invoice is observable on the host API.
 *
 * The tick answers `202 { fired: n }` and NOT the run ids: the door is a wake
 * signal, and Cloud's heartbeat reads `fired` as telemetry only. So the run this
 * journey observes is found the way any consumer finds it — GET /runs filtered
 * to the automation — rather than handed back by the thing that woke it.
 *
 * Schedule-semantics note: `createVendo` takes no `now`, so the schedule leg
 * uses a PAST `at` (due on the first /tick after enable) rather than an
 * `every`/`cron` that would need real wall-clock minutes to elapse.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationRecord, AutomationTask, RunContext, When } from "@vendoai/core";
import { automationsInternals } from "@vendoai/automations";
import {
  ADA,
  createStack,
  decideApprovals,
  hostFetch,
  pastAtIso,
  resetFixture,
  waitForRunStatus,
  type Stack,
  type WireApproval,
} from "../src/harness.js";

const CREATE = "host_invoices_create";

interface Invoice {
  id: string;
  memo: string;
  amountCents: number;
  status: string;
}

async function hostInvoices(): Promise<Invoice[]> {
  const response = await hostFetch("/api/invoices", ADA.subject);
  expect(response.status).toBe(200);
  return ((await response.json()) as { invoices: Invoice[] }).invoices;
}

/** A steps automation that creates one invoice from static JSONata args. */
const createInvoiceTask = (memo: string): AutomationTask => ({
  kind: "steps",
  steps: [{
    id: "create",
    tool: CREATE,
    args: {
      customerId: "'cus_j4'",
      amountCents: "424242",
      currency: "'USD'",
      memo: `'${memo}'`,
    },
  }],
});

/** The authoring context a chat door would hold: a present user, in a session,
 *  speaking for themselves. Only `principal.subject` decides what may be
 *  authored (`speaksFor`); the rest is what every RunContext carries. */
const ADA_CTX: RunContext = {
  principal: ADA,
  venue: "chat",
  presence: "present",
  sessionId: "sess_j4",
};

/** The one create operation, off the composed umbrella's own engine. */
const createAutomation = (stack: Stack, when: When, memo: string): Promise<AutomationRecord> =>
  automationsInternals(stack.vendo.automations).create({
    owner: ADA,
    when,
    task: createInvoiceTask(memo),
    authoredBy: "chat",
  }, ADA_CTX);

/** Arm it over the wire and settle every ask the capture flow raised. */
async function armOverWire(stack: Stack, id: string): Promise<WireApproval[]> {
  const enabled = (await (await stack.wireFetch(`/automations/${id}/enable`, { method: "POST" }, ADA)).json()) as {
    enabled: boolean;
    missing: WireApproval[];
  };
  expect(enabled.enabled).toBe(true);
  expect((await decideApprovals(stack, enabled.missing.map((request) => request.id), { approve: true }, ADA)).status)
    .toBe(200);
  return enabled.missing;
}

/**
 * The tick secret this deployment was configured with — the ONE credential both
 * wakers use, and the KEY the signature is verified against.
 *
 * That makes it a PRECONDITION of the heartbeat flow, not a detail: with it
 * unset the door can verify nothing and refuses a correctly-signed knock too.
 * So this asserts rather than asserting-by-`!`, and the flow below proves the
 * heartbeat only for a deployment that HAS a secret. How a deployment is meant
 * to learn that secret from Cloud is a separate, open question.
 */
const tickSecret = (): string => {
  const secret = process.env.VENDO_TICK_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("VENDO_TICK_SECRET is unset — the heartbeat flow cannot be proven without it");
  }
  return secret;
};

/**
 * Vendo Cloud's heartbeat knock: a standard-webhooks signature over the EMPTY
 * body, which is the only thing the door is ever sent.
 *
 * The signed bytes are `${webhook-id}.${webhook-timestamp}.` and the key is the
 * secret BASE64URL-DECODED — the same encoding `verifySignature` in
 * `@vendoai/automations` uses for a per-record webhook secret, and the encoding
 * the Cloud signer was proven RED→GREEN against. The two halves of this seam
 * live in different repos, so the encoding is the one thing that can silently
 * disagree: keying on the secret's characters instead would 401 every knock in
 * the fleet forever while every in-repo test still passed.
 */
const heartbeatHeaders = (secret: string, id = "msg_heartbeat"): Record<string, string> => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`${id}.${timestamp}.`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
};

/** The automation's runs, read the way any consumer reads them. */
async function wireRuns(stack: Stack, id: string): Promise<Array<{ id: string }>> {
  const response = await stack.wireFetch(`/runs?automationId=${id}`, {}, ADA);
  expect(response.status).toBe(200);
  return ((await response.json()) as { runs: Array<{ id: string }> }).runs;
}

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J4: automation lifecycle through the composed wire", () => {
  it("(schedule) creates, enables+captures grants, then a due `at` fires on /tick and creates the invoice for real", async () => {
    await resetFixture();
    stack = await createStack();
    const MEMO = "J4 scheduled invoice";

    const automation = await createAutomation(stack, { at: pastAtIso() }, MEMO);
    expect(automation.id.startsWith("atm_")).toBe(true);
    // The record holds no app reference of any kind — the layering flip.
    expect(automation).toMatchObject({ owner: ADA, when: { kind: "schedule", at: expect.any(String) } });

    // --- Enable: the capture flow surfaces one approval per referenced tool -
    const missing = await armOverWire(stack, automation.id);
    expect(missing.map((request) => request.call.tool)).toEqual([CREATE]);

    // --- The minted grant is standing, automation-bound, source:"automation" -
    const grants = await stack.sql<{
      subject: string;
      tool: string;
      automation_id: string;
      source: string;
      duration: string;
    }>(
      "SELECT subject, tool, automation_id, source, duration FROM vendo_grants WHERE automation_id = $1",
      [automation.id],
    );
    expect(grants).toEqual([{
      subject: ADA.subject,
      tool: CREATE,
      automation_id: automation.id,
      source: "automation",
      duration: "standing",
    }]);

    // Nothing has run yet: no invoice with our memo.
    expect((await hostInvoices()).some((invoice) => invoice.memo === MEMO)).toBe(false);

    // --- Fire the schedule: POST /tick with the bearer secret --------------
    const tick = await stack.wireFetch("/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.VENDO_TICK_SECRET}` },
    });
    expect(tick.status).toBe(202);
    expect(await tick.json()).toEqual({ fired: 1 });

    // --- Observe: run ok, step outcome ok, REAL host side effect ------------
    const runs = await wireRuns(stack, automation.id);
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;
    const run = await waitForRunStatus(stack, runId, ADA, "ok");
    expect(run.automationId).toBe(automation.id);
    expect(run.steps.map(({ id, tool, outcome }) => ({ id, tool, outcome }))).toEqual([
      { id: "create", tool: CREATE, outcome: "ok" },
    ]);

    const created = (await hostInvoices()).filter((invoice) => invoice.memo === MEMO);
    expect(created).toHaveLength(1);
    expect(created[0]?.amountCents).toBe(424242);

    // The away run also lands the run row as ok + is audited under the automation.
    expect((await stack.sql<{ status: string }>("SELECT status FROM vendo_runs WHERE id = $1", [runId]))[0]?.status)
      .toBe("ok");
    expect(Number((await stack.sql<{ count: unknown }>(
      "SELECT COUNT(*)::int AS count FROM vendo_audit WHERE kind = 'run' AND event->'trigger'->>'automationId' = $1",
      [automation.id],
    ))[0]?.count)).toBeGreaterThanOrEqual(1);

    // GET /automations lists it armed — a FLAT list of records now.
    const list = (await (await stack.wireFetch("/automations", {}, ADA)).json()) as AutomationRecord[];
    expect(list.find((record) => record.id === automation.id)?.armed).toBe(true);
    // The webhook key is never on a read: only the webhook door sees one.
    expect(list.every((record) => record.webhookSecret === undefined)).toBe(true);

    // A second tick claims nothing: the door is idempotent.
    const again = await stack.wireFetch("/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.VENDO_TICK_SECRET}` },
    });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ fired: 0 });
  });

  it("(host-event) fires via vendo.emit, previews with dry-run, and disable stops firing", async () => {
    await resetFixture();
    stack = await createStack();
    const EVENT = "j4.invoice.ready";
    const MEMO = "J4 host-event invoice";

    const automation = await createAutomation(stack, { event: EVENT }, MEMO);
    expect(automation.when).toEqual({ kind: "host-event", event: EVENT });
    await armOverWire(stack, automation.id);

    // --- dry-run previews the plan WITHOUT executing ----------------------
    const plan = (await (await stack.wireFetch(`/automations/${automation.id}/dry-run`, { method: "POST" }, ADA)).json()) as {
      steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
      grantsMissing: string[];
    };
    expect(plan.steps.map(({ id, tool }) => ({ id, tool }))).toEqual([{ id: "create", tool: CREATE }]);
    // The captured grant covers the step, so nothing is missing / would-ask.
    expect(plan.grantsMissing).toEqual([]);
    expect(plan.steps.every((step) => step.wouldAsk === false)).toBe(true);
    // dry-run executed nothing.
    expect((await hostInvoices()).some((invoice) => invoice.memo === MEMO)).toBe(false);

    // --- Fire the host-event seam: vendo.emit -----------------------------
    const runIds = await stack.vendo.emit(EVENT, { requestedBy: "j4" }, ADA);
    expect(runIds).toHaveLength(1);
    const run = await waitForRunStatus(stack, runIds[0]!, ADA, "ok");
    expect(run.steps.map(({ tool, outcome }) => ({ tool, outcome }))).toEqual([{ tool: CREATE, outcome: "ok" }]);
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);

    // --- disable stops firing: a second emit produces no new run ----------
    expect((await stack.wireFetch(`/automations/${automation.id}/disable`, { method: "POST" }, ADA)).status).toBe(200);
    // Disabling over the wire is a PERSON's decision, and it says so on the row.
    expect((await (await stack.wireFetch(`/automations/${automation.id}`, {}, ADA)).json() as AutomationRecord).disarmedBy)
      .toBe("user");
    const afterDisable = await stack.vendo.emit(EVENT, { requestedBy: "j4-again" }, ADA);
    expect(afterDisable).toEqual([]);
    // Still exactly one invoice from the single pre-disable run.
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);
    expect(Number((await stack.sql<{ count: unknown }>(
      "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE automation_id = $1",
      [automation.id],
    ))[0]?.count)).toBe(1);
  });

  it("(cloud heartbeat, secret configured) a standard-webhooks-signed knock fires the deployment, is idempotent, and an unsigned stranger gets nothing", async () => {
    await resetFixture();
    stack = await createStack();
    const MEMO = "J4 heartbeat invoice";
    // Stated in the name and here: this proves the heartbeat for a deployment
    // that HOLDS a tick secret. `createStack` configures one.
    const secret = tickSecret();

    const automation = await createAutomation(stack, { at: pastAtIso() }, MEMO);
    await armOverWire(stack, automation.id);

    // A stranger who found the endpoint but holds no credential: 401, and
    // nothing fires. Asserted BEFORE the good knock, so a door that fired on
    // every request could not hide behind the real one's side effect.
    const unsigned = await stack.wireFetch("/tick", { method: "POST" });
    expect(unsigned.status).toBe(401);
    const wrongKey = await stack.wireFetch("/tick", {
      method: "POST",
      headers: heartbeatHeaders("bm90LXRoZS1zZWNyZXQ"),
    });
    expect(wrongKey.status).toBe(401);
    expect(await wireRuns(stack, automation.id)).toEqual([]);
    expect((await hostInvoices()).some((invoice) => invoice.memo === MEMO)).toBe(false);

    // THE HEARTBEAT: no bearer header at all — only the signature Cloud sends.
    const knock = await stack.wireFetch("/tick", {
      method: "POST",
      headers: heartbeatHeaders(secret),
    });
    expect(knock.status).toBe(202);
    expect(await knock.json()).toEqual({ fired: 1 });

    // It really ran: the run row is ok and the invoice exists on the host API.
    const runs = await wireRuns(stack, automation.id);
    expect(runs).toHaveLength(1);
    expect((await waitForRunStatus(stack, runs[0]!.id, ADA, "ok")).status).toBe("ok");
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);

    // Idempotent under a RETRYING heartbeat: a fresh delivery id still claims
    // nothing, because due-ness lives in the engine's cursors and not in the
    // knock. `fired: 0` is the honest answer, never a re-fire.
    const retry = await stack.wireFetch("/tick", {
      method: "POST",
      headers: heartbeatHeaders(secret, "msg_heartbeat_retry"),
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ fired: 0 });
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);
  });
});
