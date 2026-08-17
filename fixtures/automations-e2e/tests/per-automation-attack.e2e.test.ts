/** ADVERSARIAL suite for "an automation is a first-class record".
 *
 * The slice's core claim is that a grant minted while arming ONE record never
 * authorizes another. `per-automation.e2e.test.ts` proves the ARM-TIME half of
 * that (the consent moment still asks). This suite attacks the other half — the
 * half that actually protects anyone: what happens when the sibling record
 * FIRES.
 *
 * Everything here goes through the real PGlite store, the real guard and the
 * real fixture host app; the invoice memo on the fixture is the "did it really
 * happen" probe, because a run row can say `ok` about work that never landed and
 * a run row can say `pending-approval` about work that already did.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { descriptorHash } from "@vendoai/core";
import type { ApprovalRequest, CreateAutomation, CreateAutomationInput, PermissionGrant } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { automationsInternals, createAutomations, type AutomationsEngine } from "@vendoai/automations";
import {
  createAutomation,
  createStack,
  fixtureActAs,
  fixtureBaseUrl,
  fixtureFetch,
  hostTools,
  ownerCtx,
  resetFixture,
} from "../src/harness.js";
import { ADA, approve, fixtureInvoices } from "../src/support.js";

/** The probe invoice: any authenticated fixture session may PATCH it, so its
 *  memo is a pure "the away call really executed" witness. */
const PROBE = "inv_0006";

const listStep = { id: "list", tool: "host_invoices_list" };
const touchStep = (memo: string) => ({
  id: "touch",
  tool: "host_invoices_update",
  args: { id: "event.id", memo: `'${memo}'` },
});

const probeMemo = async (): Promise<string | undefined> =>
  (await fixtureInvoices()).find((invoice) => invoice.id === PROBE)?.memo;

/** Two records of ONE owner that declare the SAME tool. Nothing but the
 *  automation id can tell their authority apart, which is the whole point. */
const twin = (event: string, memo: string): CreateAutomationInput => ({
  owner: ADA,
  when: { event },
  task: { kind: "steps", steps: [touchStep(memo)] },
  authoredBy: "chat",
  armed: false,
});

/**
 * The harness's `createStack` with the one extra seam this suite needs: a
 * caller-owned `dataDir`, so one PGlite database can be CLOSED and REOPENED
 * under a completely fresh engine + guard. No apps runtime — the automations
 * package has zero app concepts, so the engine is composed without one and the
 * create op is reached the way every authoring door reaches it.
 */
interface AttackStack {
  store: VendoStore;
  guard: VendoGuard;
  automations: AutomationsEngine;
  create: CreateAutomation;
  /** A SECOND engine over the SAME store — two authorities ticking one
   *  deployment, which is what the schedule-cursor claim exists for. */
  extraEngine(): AutomationsEngine;
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

async function compose(dataDir: string): Promise<AttackStack> {
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({ store });
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    actAs: fixtureActAs,
    fetch: fixtureFetch,
  });
  const config = { tools: guard.bind(actions), guard, store };
  const automations = createAutomations(config);
  return {
    store,
    guard,
    automations,
    create: automationsInternals(automations).create,
    extraEngine: () => createAutomations(config),
    async sql(query: string, params?: unknown[]) {
      const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      return (await raw.query(query, params)).rows as never;
    },
    async close() {
      await store.close();
    },
  };
}

/** `approve` from support wants the harness's full Stack; the composed one is
 *  deliberately smaller, so the decision goes through the same guard door. */
const allow = (stack: { guard: VendoGuard }, requests: ApprovalRequest[]) =>
  stack.guard.approvals.decide(requests.map(({ id }) => id), { approve: true }, ADA);

/** The grant rows for a subject, as the DATABASE holds them. */
const grantRows = (stack: Pick<AttackStack, "sql">, subject: string) => stack.sql<{
  tool: string;
  automation_id: string | null;
  app_id: string | null;
  source: string;
}>(
  "SELECT tool, automation_id, app_id, source FROM vendo_grants WHERE subject = $1 ORDER BY automation_id, tool",
  [subject],
);

describe("attack 1 — a grant for record A must not authorize record B", () => {
  beforeEach(resetFixture);

  it("keeps the grant scoped to the automation across a full store reload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-per-automation-attack-"));
    const ctx = ownerCtx(ADA.subject);
    let alphaId = "";
    let betaId = "";
    try {
      const first = await compose(dataDir);
      try {
        alphaId = (await first.create(twin("twin.alpha", "alpha-ran"), ctx)).id;
        betaId = (await first.create(twin("twin.beta", "beta-ran"), ctx)).id;
        const armed = await first.automations.enable(alphaId, ctx);
        await allow(first, armed.missing);
        // The grant names the record and no app — a record has none to name.
        expect(await grantRows(first, ADA.subject)).toEqual([
          { tool: "host_invoices_update", automation_id: alphaId, app_id: null, source: "automation" },
        ]);
      } finally {
        await first.close();
      }

      // A COMPLETELY fresh engine + guard over the same database: nothing is
      // carried in memory, so what follows is read back off the row.
      const second = await compose(dataDir);
      try {
        // Alpha's own grant survived the round trip — if `automation_id` had
        // been dropped on persist this would still pass, so the next assert is
        // the one that separates the two.
        expect((await second.automations.enable(alphaId, ctx)).missing).toEqual([]);
        // Beta's consent moment must still ask, after the reload.
        expect((await second.automations.enable(betaId, ctx)).missing.map((r) => r.call.tool))
          .toEqual(["host_invoices_update"]);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses record B's away call while only record A is granted", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const alpha = await createAutomation(stack, twin("twin.alpha", "alpha-ran"), ctx);
      const beta = await createAutomation(stack, twin("twin.beta", "beta-ran"), ctx);
      await approve(stack, (await stack.automations.enable(alpha.id, ctx)).missing);

      // Beta is armed, and its asks are left PENDING — the documented state of a
      // partially granted automation, whose ungranted steps fail at fire time.
      expect((await stack.automations.enable(beta.id, ctx)).missing).toHaveLength(1);

      const [runId] = await stack.automations.emit("twin.beta", { id: PROBE }, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);
      // Nothing beta was allowed to do has been allowed yet, so the run must
      // stop LOUDLY on the permission it does not hold — and the invoice must be
      // untouched.
      expect(run?.status).toBe("error");
      expect(run?.error?.code).toBe("needs-permission");
      expect(await probeMemo()).not.toBe("beta-ran");

      // Positive control: alpha, which WAS granted, really does run away.
      const [alphaRun] = await stack.automations.emit("twin.alpha", { id: PROBE }, ADA);
      expect((await stack.automations.runs.get(alphaRun!, ctx))?.status).toBe("ok");
      expect(await probeMemo()).toBe("alpha-ran");
    } finally {
      await stack.close();
    }
  });
});

describe("attack 4 — one decision, one record, one mint", () => {
  beforeEach(resetFixture);

  it("cannot be replayed into a grant for the sibling record", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const alphaRecord = await createAutomation(stack, twin("twin.alpha", "alpha-ran"), ctx);
      const betaRecord = await createAutomation(stack, twin("twin.beta", "beta-ran"), ctx);
      const alpha = await stack.automations.enable(alphaRecord.id, ctx);
      const beta = await stack.automations.enable(betaRecord.id, ctx);
      const alphaId = alpha.missing[0]!.id;
      expect(beta.missing[0]!.id).not.toBe(alphaId);

      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA);
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", automation_id: alphaRecord.id, app_id: null, source: "automation" },
      ]);

      // The same yes, decided again — a second mint here is a second authority.
      // A refusal (conflict) is the correct answer; what matters is the rows.
      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA).catch(() => undefined);
      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA).catch(() => undefined);
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", automation_id: alphaRecord.id, app_id: null, source: "automation" },
      ]);
      // Beta's own ask is untouched and still pending.
      expect((await stack.guard.approvals.pending(ADA)).map((request) => request.id))
        .toEqual([beta.missing[0]!.id]);

      // Deciding BETA's ask mints beta's grant, and only beta's.
      await stack.guard.approvals.decide([beta.missing[0]!.id], { approve: true }, ADA);
      expect((await grantRows(stack, ADA.subject)).map(({ automation_id }) => automation_id).sort())
        .toEqual([alphaRecord.id, betaRecord.id].sort());
    } finally {
      await stack.close();
    }
  });
});

describe("attack 5 — two schedule records, one tick", () => {
  beforeEach(resetFixture);

  it("claims a cursor per record with no cross-claim and no double fire", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-per-automation-tick-"));
    const stack = await compose(dataDir);
    try {
      const ctx = ownerCtx(ADA.subject);
      const schedule = (): CreateAutomationInput => ({
        owner: ADA,
        when: { every: "1m" },
        task: { kind: "steps", steps: [listStep] },
        authoredBy: "chat",
        armed: false,
      });
      const early = await stack.create(schedule(), ctx);
      const late = await stack.create(schedule(), ctx);
      await allow(stack, (await stack.automations.enable(early.id, ctx)).missing);
      await allow(stack, (await stack.automations.enable(late.id, ctx)).missing);

      // Each record got its OWN cursor row, keyed by the record.
      expect((await stack.sql<{ id: string }>(
        "SELECT id FROM vendo_records WHERE collection = 'automations:schedule' ORDER BY id",
      )).map(({ id }) => id).sort()).toEqual([early.id, late.id].sort());

      // TWO authorities tick the same deployment at the same instant — the
      // claim is what stops one record from firing twice, or one record's claim
      // from swallowing the other's.
      const other = stack.extraEngine();
      const at = new Date(Date.now() + 180_000);
      const [mine, theirs] = await Promise.all([stack.automations.tick(at), other.tick(at)]);
      const fired = [...mine, ...theirs];
      expect(new Set(fired).size).toBe(fired.length);

      const runs = (await stack.automations.runs.list({ owner: ADA.subject }, ctx)).runs;
      expect(runs.map((run) => run.automationId).sort()).toEqual([early.id, late.id].sort());
      expect(runs.every((run) => run.status === "ok")).toBe(true);

      // And the cursors are spent: a third tick at the same instant fires nothing.
      expect(await stack.automations.tick(at)).toEqual([]);
    } finally {
      await stack.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("attack 6 — a non-automation grant still never reaches the automation venue", () => {
  beforeEach(resetFixture);

  it("refuses a chat grant and an mcp grant for every record of the owner", async () => {
    const stack = await createStack({
      policy: { rules: [{ match: { tool: "host_invoices_update", venue: "chat" }, action: "ask" }] },
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      // A REAL standing chat grant, minted the way a person mints one.
      const parked = await stack.bound.execute(
        { id: "call_chat_grant", tool: "host_invoices_update", args: { id: PROBE, memo: "chat-ran" } },
        ctx,
      );
      expect(parked.status).toBe("pending-approval");
      const chatAsk = (await stack.guard.approvals.pending(ADA))
        .find((request) => request.call.tool === "host_invoices_update");
      await stack.guard.approvals.decide(
        chatAsk!.id,
        { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        ADA,
      );
      expect((await stack.guard.grants.list(ADA)).find((grant) => grant.source === "chat")).toBeDefined();

      const alpha = await createAutomation(stack, twin("twin.alpha", "alpha-ran"), ctx);
      const beta = await createAutomation(stack, twin("twin.beta", "beta-ran"), ctx);
      // An mcp-source standing grant naming this very record: everything matches
      // except the one thing that must decide it.
      const descriptor = (await stack.bound.descriptors(ctx))
        .find((candidate) => candidate.name === "host_invoices_update")!;
      const mcpGrant: PermissionGrant = {
        id: "grt_mcp_standing",
        subject: ADA.subject,
        tool: "host_invoices_update",
        descriptorHash: descriptorHash(descriptor),
        scope: { kind: "tool" },
        duration: "standing",
        automationId: alpha.id,
        source: "mcp",
        grantedAt: new Date().toISOString(),
      };
      await stack.store.records("vendo_grants").put({
        id: mcpGrant.id,
        data: mcpGrant,
        refs: { subject: mcpGrant.subject, tool: mcpGrant.tool, automation_id: alpha.id },
      });

      // Both records armed, NOTHING approved for either.
      expect((await stack.automations.enable(alpha.id, ctx)).missing).toHaveLength(1);
      expect((await stack.automations.enable(beta.id, ctx)).missing).toHaveLength(1);
      const memoBefore = await probeMemo();

      for (const [event, memo] of [["twin.alpha", "alpha-ran"], ["twin.beta", "beta-ran"]] as const) {
        const [runId] = await stack.automations.emit(event, { id: PROBE }, ADA);
        expect(await probeMemo()).not.toBe(memo);
        const run = await stack.automations.runs.get(runId!, ctx);
        expect(run?.status).toBe("error");
        expect(run?.error?.code).toBe("needs-permission");
      }
      expect(await probeMemo()).toBe(memoBefore);
    } finally {
      await stack.close();
    }
  });
});
