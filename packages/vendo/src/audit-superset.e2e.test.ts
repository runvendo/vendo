/**
 * `audit ⊇ transcript` — architecture design §3's mirroring invariant, and
 * evaluation E7's last line ("the audit trail is a superset of the transcript for
 * every run").
 *
 * Why this file exists: the invariant was ASSERTED NOWHERE. `packages/harnesses`
 * has a comment naming it (runtime.ts, `reportRun`) and a dozen suites spot-check
 * one audit row apiece, but nothing compared the two planes — so any future
 * routing change that put an accountable event on the story layer and forgot the
 * audit row would ship green. Billing and reconciliation read the audit plane
 * ONLY; a hole there is money and a compliance answer, not a rendering bug.
 *
 * It drives ONE real composed turn through `vendo.handler` — real store, real
 * guard, real registry, real policy, a real interactive approval answered over the
 * wire — carrying every routing class §3 names: text, a guarded call, an approval,
 * an error, an in-box file op, a subagent receipt, and usage.
 *
 * WHAT "⊇" MEANS HERE, precisely. Read strictly as sets of events the relation is
 * false, and deliberately so: §3's own routing table sends `text` to "screen +
 * transcript" and gives it no audit row. The invariant's purpose clause is the
 * definition — "billing and reconciliation never depend on the story layer" — so
 * the superset is over ACCOUNTABLE events (anything with a consequence to
 * reconcile: a guarded call, an approval, a failure, hired staff, tokens spent),
 * and prose is the story layer itself rather than a member of the set. The
 * classification below is explicit per part type for exactly that reason, and an
 * UNKNOWN part type is a failure: a new persisted part is a new claim about which
 * plane it belongs to, and someone has to make it on purpose.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness, reportHire } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_ledger" };
const THREAD = "thr_superset";

const READ_TOOL = "maple_invoices_list";
const WRITE_TOOL = "maple_payments_send";
const FAILING_TOOL = "maple_reports_read";

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-superset-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/**
 * Three host tools, one per outcome class the turn needs: a read that runs
 * silently, a write the `cautious` policy parks for a human, and a read whose
 * host implementation throws.
 */
function hostTools(): ToolRegistry {
  const descriptors: ToolDescriptor[] = [
    {
      name: READ_TOOL,
      title: "List invoices",
      description: "List the signed-in customer's invoices",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    {
      name: WRITE_TOOL,
      title: "Send a payment",
      description: "Send a payment to a payee",
      inputSchema: { type: "object", properties: { amount: { type: "number" } } },
      risk: "write",
    },
    {
      name: FAILING_TOOL,
      title: "Read reports",
      description: "Read the customer's reports",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
  ];
  return {
    async descriptors() {
      return descriptors;
    },
    async execute(call) {
      if (call.tool === FAILING_TOOL) throw new Error("the reports service is down");
      return { status: "ok", output: { ok: true } };
    },
  };
}

interface AuditRow {
  kind: string;
  tool?: string;
  outcome?: string;
  detail?: Record<string, unknown>;
}

const auditRows = async (store: VendoStore): Promise<AuditRow[]> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
  return records.map((record) => record.data as unknown as AuditRow);
};

const transcript = async (vendo: Vendo): Promise<UIMessage[]> => {
  const response = await vendo.handler(new Request(`https://host.test/api/vendo/threads/${THREAD}`));
  return ((await response.json()) as { messages: UIMessage[] }).messages;
};

/**
 * The user's tap, over the public wire — `GET /approvals` then
 * `POST /approvals/decide`, exactly what the browser does when the popup appears
 * mid-turn. Polled because the interactive `call()` blocks INSIDE the turn: the
 * approval only exists once the guard has parked it, which happens while this
 * request is still in flight.
 *
 * `turnFinished` is the stop condition, NOT a wall clock. This poll used to give
 * up after 10s — a second, invisible speed limit inside a test whose own budget
 * is 30s. Under full-suite contention the file takes ~62s and the turn is still
 * legitimately in flight at 10s, so the poll rejected, the approval was never
 * decided, the turn never returned, and the run reported an unhandled rejection
 * plus a generic 30s timeout — none of which named the real cause. The turn
 * cannot complete until the approval is decided, so "the turn finished and
 * nothing was parked" is the only honest failure here; vitest's testTimeout stays
 * the single hang-detector.
 */
async function tapApprovalWhenItAppears(
  vendo: Vendo,
  turnFinished: () => boolean,
): Promise<string> {
  while (!turnFinished()) {
    const listed = await vendo.handler(
      new Request("https://host.test/api/vendo/approvals", {
        headers: { "content-type": "application/json" },
      }),
    );
    if (listed.ok) {
      const pending = (await listed.json()) as Array<{ id: string; call?: { tool?: string } }>;
      const mine = pending.find((request) => request.call?.tool === WRITE_TOOL);
      if (mine !== undefined) {
        const decided = await vendo.handler(
          new Request("https://host.test/api/vendo/approvals/decide", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [mine.id], decision: { approve: true } }),
          }),
        );
        if (!decided.ok) throw new Error(`decide failed (${decided.status}): ${await decided.text()}`);
        return mine.id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the turn finished and no approval was ever parked for the write tool");
}

interface TurnResult {
  vendo: Vendo;
  store: VendoStore;
  /** What the harness observed, so a mis-scripted turn fails as itself. */
  results: Record<string, string>;
  approvalId: string;
}

/** ONE composed turn carrying every routing class in §3's table. */
async function runTheTurn(): Promise<TurnResult> {
  const store = await tempStore();
  const results: Record<string, string> = {};

  const harness = defineHarness({
    name: "every-routing-class",
    async *run(turn) {
      // text → screen + transcript.
      yield { type: "text", delta: "Let me look at your invoices." };

      // A guarded call the policy runs silently → transcript + audit.
      results[READ_TOOL] = (await turn.tools.call(READ_TOOL, {})).status;

      // A guarded call the `cautious` policy parks → an approval card in the
      // transcript, an approval row in the audit, then the executed call.
      results[WRITE_TOOL] = (await turn.tools.call(WRITE_TOOL, { amount: 1400 })).status;

      // A guarded call whose host implementation throws → an errored tool part
      // in the transcript, an errored tool-call row in the audit.
      results[FAILING_TOOL] = (await turn.tools.call(FAILING_TOOL, {})).status;

      // An IN-BOX file op — §3: "nowhere but the commit diff (audit)". Never a
      // transcript part, so it can only ever make the audit plane the larger one.
      await turn.workspace.writeFile("/user/memory/notes.md", "she prefers tables\n");

      // Hired staff → one transcript receipt line, one audit row.
      reportHire({
        purpose: "Check the invoice totals add up",
        summary: "They do.",
        usage: { inputTokens: 120, outputTokens: 20 },
      });

      // usage → audit/metering ONLY. This is the half billing reads.
      yield { type: "usage", inputTokens: 900, outputTokens: 300, model: "test-model" };

      yield { type: "text", delta: "Done — the payment is sent." };

      // error → screen + audit. Plain language, no internals (the voice law).
      yield { type: "error", message: "I could not reach your reports just now.", code: "upstream" };
    },
  });

  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    // `cautious` is what makes the approval leg real: a `write` tool asks, a
    // `read` tool runs. Without a policy every call would be `decidedBy: default`.
    guard: { policy: "cautious" },
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools());

  // The turn and the tap race on purpose — that IS the interactive approval.
  // Awaited together so neither side's rejection can float: the tap used to be
  // started bare, and when it gave up first its throw became an unhandled
  // rejection that vitest reported instead of the actual failure.
  let turnFinished = false;
  const tap = tapApprovalWhenItAppears(vendo, () => turnFinished);
  const [turn] = await Promise.all([
    (async () => {
      const response = await vendo.handler(
        new Request("https://host.test/api/vendo/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: THREAD,
            message: { id: "m1", role: "user", parts: [{ type: "text", text: "pay Acme and check my reports" }] },
          }),
        }),
      );
      await response.text();
      return response;
    })().finally(() => {
      turnFinished = true;
    }),
    tap,
  ]);
  expect(turn.status).toBe(200);
  const approvalId = await tap;

  return { vendo, store, results, approvalId };
}

/**
 * Which plane each PERSISTED part type belongs to, and what the audit plane must
 * carry for it.
 *
 * `story` means "the transcript's own layer — no audit row is owed, and billing
 * must not need one". Everything else names the audit row that MUST exist.
 * An unlisted type fails the test by design: see the header note.
 */
type Accountable = (row: AuditRow, part: Record<string, unknown>) => boolean;

const STORY_PARTS = new Set([
  // Prose, and the SDK's own turn scaffolding. §3 routes text to screen +
  // transcript and gives it no audit row; step boundaries are not events at all.
  "text",
  "reasoning",
  "step-start",
]);

const ACCOUNTABLE_PARTS: Record<string, Accountable> = {
  // A guarded call. The audit row is minted inside the ONE choke point
  // (`VendoGuard.bind(...).execute`), so a mirrored call with no row means a
  // second, unguarded execution path exists.
  "dynamic-tool": (row, part) =>
    (row.kind === "tool-call" || row.kind === "policy-decision") && row.tool === part["toolName"],
  // The consent card. The part is the card being RAISED, so the row that
  // corresponds to it is the park (`outcome: "pending-approval"`) — not the later
  // decision row, which is a different event. Correlating on `kind` alone let a
  // dropped park write stay green because the decision row covered for it.
  "data-vendo-approval": (row) => row.kind === "approval" && row.outcome === "pending-approval",
  // The subagent receipt (persisted, unrendered). `reportRun` gives it its own
  // row because the guard never saw the hire — only the specialist's calls.
  "data-vendo-subagent": (row) =>
    row.kind === "run" && typeof (row.detail as { subagent?: unknown } | undefined)?.subagent === "object",
  // The turn's failure, kept in the transcript so a reload still says why the
  // answer never came (self-serve P). The audit plane's counterpart is the run
  // row's `error` — one turn can only fail once, so one part, one row.
  "data-vendo-turn-error": (row) =>
    row.kind === "run" && typeof (row.detail as { error?: unknown } | undefined)?.error === "object",
};

describe("audit ⊇ transcript (design §3, evaluation E7)", () => {
  it("gives every accountable event in the transcript a corresponding audit row", async () => {
    const { vendo, store, results, approvalId } = await runTheTurn();

    // The turn really carried all four legs — otherwise the invariant below is
    // being proven over an empty set, which is the way this test could lie.
    expect(results[READ_TOOL]).toBe("ok");
    expect(results[WRITE_TOOL]).toBe("ok");
    expect(results[FAILING_TOOL]).toBe("error");
    expect(approvalId).toMatch(/^apr_/);

    const messages = await transcript(vendo);
    const rows = await auditRows(store);
    const parts = messages.flatMap((message) =>
      message.parts.map((part) => part as unknown as Record<string, unknown>),
    );

    // Every persisted part is classified on purpose. A new part type routed to
    // the transcript lands here first, and someone decides which plane owns it.
    const unclassified = [...new Set(parts.map((part) => String(part["type"])))]
      .filter((type) => !STORY_PARTS.has(type) && ACCOUNTABLE_PARTS[type] === undefined);
    expect(unclassified, "a persisted transcript part type nobody has assigned a plane").toEqual([]);

    const accountable = parts.filter((part) => ACCOUNTABLE_PARTS[String(part["type"])] !== undefined);
    // Every accountable CLASS is actually present, so no mapping below is proven
    // over an empty set — the way this test could quietly stop testing anything.
    expect(new Set(accountable.map((part) => String(part["type"])))).toEqual(
      new Set(Object.keys(ACCOUNTABLE_PARTS)),
    );
    // Three tool parts + the approval card + the receipt.
    expect(accountable.length).toBeGreaterThanOrEqual(5);

    for (const part of accountable) {
      const matches = ACCOUNTABLE_PARTS[String(part["type"])] as Accountable;
      const covered = rows.some((row) => matches(row, part));
      expect(
        covered,
        `transcript part ${String(part["type"])}`
        + `${part["toolName"] === undefined ? "" : ` (${String(part["toolName"])})`}`
        + " reached the story layer with no audit row — billing cannot see it",
      ).toBe(true);
    }
  });

  it("carries in the audit what the transcript must NOT: metering and in-box ops", async () => {
    const { vendo, store } = await runTheTurn();
    const messages = await transcript(vendo);
    const rows = await auditRows(store);
    const storyText = JSON.stringify(messages);

    // Metering: the tokens billing charges for are in the audit plane…
    const metered = rows.find(
      (row) => row.kind === "run" && (row.detail as { usage?: unknown } | undefined)?.usage !== undefined,
    );
    const usage = (metered?.detail as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined)?.usage;
    expect(usage?.inputTokens).toBe(900);
    expect(usage?.outputTokens).toBe(300);
    // The specialist's spend is NOT folded into the turn total — it rides its own
    // row. Pinned because it is the half a naive "sum the run rows" reconciliation
    // would double-count or miss entirely, and nothing else says which it is.
    const hired = rows.find(
      (row) => row.kind === "run" && (row.detail as { subagent?: unknown } | undefined)?.subagent !== undefined,
    );
    expect((hired?.detail as { subagent?: { usage?: unknown } } | undefined)?.subagent?.usage)
      .toEqual({ inputTokens: 120, outputTokens: 20 });
    // …and NOWHERE in the story layer. `usage` is the one yield with no screen
    // and no transcript route at all, so a token count appearing in a persisted
    // part means the routing table was widened without anyone saying so.
    expect(storyText).not.toContain("inputTokens");
    expect(storyText).not.toContain("outputTokens");

    // The failure: the audit plane records that the turn ended badly…
    const failed = rows.find(
      (row) => row.kind === "run" && (row.detail as { error?: unknown } | undefined)?.error !== undefined,
    );
    expect((failed?.detail as { error?: { code?: string } } | undefined)?.error?.code).toBe("upstream");

    // The in-box file op: it wrote a real file (the workspace door proves it)…
    const workspace = await vendo.harness.workspace(principal);
    expect(await workspace.readFile("/user/memory/notes.md")).toBe("she prefers tables\n");
    // …and none of it is in the transcript. §3: in-box ops "don't mirror", which
    // is what keeps the write law's ~15 rows/turn true.
    expect(storyText).not.toContain("she prefers tables");
    expect(storyText).not.toContain("/user/memory/notes.md");

    // The relation, stated as the count it implies: the audit plane is strictly
    // larger than the accountable half of the story layer.
    const accountableParts = messages
      .flatMap((message) => message.parts as unknown as Array<{ type: string }>)
      .filter((part) => ACCOUNTABLE_PARTS[part.type] !== undefined);
    expect(rows.length).toBeGreaterThan(accountableParts.length);
  });

  it("audits the guard's decision for every mirrored call, not just the successful ones", async () => {
    // The narrow version of the invariant that catches the likeliest regression:
    // an error or a refusal is the outcome someone "optimizes" out of the audit
    // plane, because it looks like nothing happened. It is exactly what a
    // reconciliation needs to know.
    const { store } = await runTheTurn();
    const rows = await auditRows(store);

    const outcomeFor = (tool: string): string | undefined =>
      rows.find((row) => row.kind === "tool-call" && row.tool === tool)?.outcome;

    expect(outcomeFor(READ_TOOL)).toBe("ok");
    expect(outcomeFor(WRITE_TOOL)).toBe("ok");
    expect(outcomeFor(FAILING_TOOL)).toBe("error");
    // The approval leg leaves its own trail: parked, then decided.
    expect(rows.filter((row) => row.kind === "approval").length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * GAP 3 — the failure card's dedupe and its skipped-run count.
 *
 * Design §3: "One card per missing grant per app, carrying a skipped-run count —
 * never one per failed firing."
 *
 * The composed e2e proves the CARD. What nothing proved is the arithmetic, and
 * the arithmetic is where the claim splits in two:
 *
 *  - Per-APP dedupe, keyed `(appId, tool)`, EXISTS — but at ENABLE time, in the
 *    automations engine's capture reuse (`pendingCaptures` → `pendingForApp` in
 *    `packages/automations/src/consent.ts`), and it is already covered by
 *    `engine.test.ts` ("re-running enable() reuses the pending ask — no duplicate
 *    ApprovalRequest per (appId, tool)"). That is the layer it lives at, so this
 *    file does not re-stage it.
 *  - Per-FIRING dedupe does NOT exist. `#parkApproval` mints `apr_<uuid>` per
 *    call with no lookup for an existing pending row for the same missing grant
 *    (`packages/guard/src/guard.ts`), so N failed firings leave N standing cards.
 *
 * The first test below PINS that real behaviour, so the contradiction is a fact in
 * the suite rather than a paragraph in a doc — and so the day someone implements
 * the dedupe, it goes red and points at the `.skip` beside it.
 *
 * An unattended turn is driven through `vendo.harness.stream` and not the wire on
 * purpose: `POST /threads` resolves `context("chat")` with `presence: "present"`
 * hard-coded (`packages/vendo/src/wire/context.ts`), so there is no header that
 * makes a wire turn away. The harness door takes the ctx, which is what an
 * automation firing supplies.
 */
describe("the unattended failure card (design §3)", () => {
  const AUTOMATION_TOOL = "maple_payments_prepare";
  const APP_ID = "app_morning_reminders";

  /** A write tool an unattended run holds no grant for — the missing-grant case. */
  function awayTools(executed: string[]): ToolRegistry {
    const descriptor: ToolDescriptor = {
      name: AUTOMATION_TOOL,
      title: "Prepare a payment",
      description: "Draft a payment for a person to send",
      inputSchema: { type: "object", properties: { payee: { type: "string" } } },
      risk: "write",
    };
    return {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        executed.push(call.tool);
        return { status: "ok", output: { drafted: true } };
      },
    };
  }

  interface AwayFixture {
    /** One unattended firing of the same automation. Returns the call's status. */
    fire(runId: string): Promise<string>;
    /** The standing cards for this missing grant, as the user's queue lists them. */
    cards(): Promise<Array<Record<string, unknown>>>;
    executed: string[];
  }

  async function awayFixture(): Promise<AwayFixture> {
    const store = await tempStore();
    const executed: string[] = [];
    const outcomes: string[] = [];
    const harness = defineHarness({
      name: "unattended",
      async *run(turn) {
        const result = await turn.tools.call(AUTOMATION_TOOL, { payee: "Acme Utilities" });
        outcomes.push(result.status);
        yield { type: "text", delta: `status=${result.status}` };
      },
    });
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      guard: { policy: "cautious" },
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(awayTools(executed));

    return {
      executed,
      async fire(runId) {
        const response = await vendo.harness.stream({
          threadId: `thr_${runId}`,
          message: { id: `m_${runId}`, role: "user", parts: [{ type: "text", text: "run" }] } as UIMessage,
          // The automation venue, away: `isUnattended(ctx)` is the one predicate
          // that decides wait-or-fail, and this is the shape it reads.
          ctx: {
            principal,
            venue: "automation",
            presence: "away",
            appId: APP_ID as never,
            trigger: { kind: "schedule", runId } as never,
            sessionId: runId,
          } as never,
        });
        await response.text();
        return outcomes[outcomes.length - 1] ?? "none";
      },
      async cards() {
        const listed = await vendo.handler(new Request("https://host.test/api/vendo/approvals"));
        const pending = (await listed.json()) as Array<Record<string, unknown>>;
        return pending.filter(
          (request) => (request["call"] as { tool?: string } | undefined)?.tool === AUTOMATION_TOOL,
        );
      },
    };
  }

  it("fails an unattended run loudly and leaves the card STANDING", async () => {
    const fixture = await awayFixture();
    expect(await fixture.fire("run_1")).toBe("denied");
    // Nothing executed — §3: "no popup is possible, so the run fails loudly".
    expect(fixture.executed).toEqual([]);
    // And the card survives the turn, which is what "Grant & re-run" collects.
    // An interactive turn's unanswered card is abandoned at turn end instead.
    expect(await fixture.cards()).toHaveLength(1);
  });

  it("PINS the shipped counting: N failed firings leave N cards, not one", async () => {
    // §3 says "never one per failed firing". This is the opposite, and it is what
    // the code does today — `#parkApproval` has no dedupe key for
    // (app, missing grant), so an automation firing hourly accretes a row an
    // hour. Pinned rather than skipped so the arithmetic is checkable, and so
    // implementing the dedupe turns this red and points at the `.skip` below.
    const fixture = await awayFixture();
    await fixture.fire("run_1");
    await fixture.fire("run_2");
    await fixture.fire("run_3");
    expect(await fixture.cards()).toHaveLength(3);
  });

  it.skip("dedupes every failed firing onto ONE card per missing grant per app", async () => {
    // MUST BE BUILT: a stable dedupe key for (appId, tool, args-shape) on the
    // FIRE path, the way `enable()` already reuses a pending capture per
    // (appId, tool) in `packages/automations/src/consent.ts`. `#parkApproval`
    // (`packages/guard/src/guard.ts`) currently mints `apr_<uuid>` with no
    // lookup, so the fire path has no dedupe at all.
    const fixture = await awayFixture();
    await fixture.fire("run_1");
    await fixture.fire("run_2");
    await fixture.fire("run_3");
    expect(await fixture.cards()).toHaveLength(1);
  });

  it.skip("carries a skipped-run count on the standing card", async () => {
    // MUST BE BUILT: a counter field. `ApprovalRequest`
    // (`packages/core/src/grants.ts`) is `{ id, call, descriptor, inputPreview,
    // invalidatedGrant?, ctx, createdAt }` — there is nowhere for a count to
    // live, so the card cannot tell a person whether their automation missed
    // once or two hundred times. Depends on the dedupe above: without one card
    // there is nothing to count on.
    const fixture = await awayFixture();
    await fixture.fire("run_1");
    await fixture.fire("run_2");
    await fixture.fire("run_3");
    const [card] = await fixture.cards();
    expect(card).toMatchObject({ skippedRuns: 3 });
  });
});

/**
 * GAP 2 — the review failure protocol (design §7, evaluation E4) — is NOT here.
 * It is not implemented at all, and the tests naming what must be built live
 * beside the code that must change:
 * `packages/apps/src/checking/review-failure-protocol.test.ts`.
 */
