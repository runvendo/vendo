/** ADVERSARIAL suite for "an automation is an app with a LIST of triggers".
 *
 * The slice's core claim is that a grant minted while arming ONE trigger never
 * authorizes another. `per-trigger.e2e.test.ts` proves the ARM-TIME half of that
 * (the consent moment still asks). This suite attacks the other half — the half
 * that actually protects anyone: what happens when the sibling trigger FIRES.
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
import type { AppDocument, AppId, PermissionGrant, RunContext, Trigger } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { createGuard, type PolicyConfig } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { createApps } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";
import {
  automationDoc,
  createStack,
  fixtureActAs,
  fixtureBaseUrl,
  fixtureFetch,
  hostTools,
  ownerCtx,
  resetFixture,
  type Stack,
} from "../src/harness.js";
import { ADA, BOB, approve, fixtureInvoices } from "../src/support.js";

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

/** Two triggers of ONE app that declare the SAME tool. Nothing but the trigger
 *  id can tell their authority apart, which is the whole point. */
const twinDoc = (appId: AppId): AppDocument => automationDoc({
  id: appId,
  name: "Twins",
  triggers: [
    { id: "alpha", on: { kind: "host-event", event: "twin.alpha" }, run: { kind: "steps", steps: [touchStep("alpha-ran")] } },
    { id: "beta", on: { kind: "host-event", event: "twin.beta" }, run: { kind: "steps", steps: [touchStep("beta-ran")] } },
  ],
});

/**
 * The harness's `createStack` with the two extra seams this suite needs, and
 * nothing else: a caller-owned `dataDir` (so one PGlite database can be CLOSED
 * and REOPENED under a completely fresh engine + guard — the reload leg), and an
 * `editors` list behind the `appAccess` seam (so a second person can edit).
 */
interface AttackStack extends Stack {
  /** A SECOND engine over the SAME store — two authorities ticking one
   *  deployment, which is what the schedule-cursor claim exists for. */
  extraEngine(): AutomationsEngine;
}

async function compose(options: {
  dataDir: string;
  editors?: readonly string[];
  policy?: PolicyConfig;
}): Promise<AttackStack> {
  const store = createStore({ dataDir: options.dataDir });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    actAs: fixtureActAs,
    fetch: fixtureFetch,
  });
  const bound = guard.bind(actions);
  const apps = createApps({ store, guard, tools: bound, catalog: [] });
  const appAccess = options.editors === undefined
    ? undefined
    : { can: async (ctx: RunContext) => options.editors!.includes(ctx.principal.subject) };
  const engineConfig = {
    apps,
    tools: bound,
    guard,
    store,
    ...(appAccess === undefined ? {} : { appAccess }),
  };
  return {
    store,
    guard,
    bound,
    apps,
    automations: createAutomations(engineConfig),
    extraEngine: () => createAutomations(engineConfig),
    async putApp(subject: string, doc: AppDocument) {
      await store.records("vendo_apps").put({ id: doc.id, data: { subject, enabled: false, doc }, refs: { subject } });
    },
    async sql(query: string, params?: unknown[]) {
      const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      return (await raw.query(query, params)).rows as never;
    },
    async close() {
      await store.close();
    },
  };
}

/** The grant rows for a subject, as the DATABASE holds them. */
const grantRows = (stack: Stack, subject: string) => stack.sql<{
  tool: string;
  app_id: string | null;
  trigger_id: string | null;
  source: string;
}>(
  "SELECT tool, app_id, trigger_id, source FROM vendo_grants WHERE subject = $1 ORDER BY trigger_id NULLS FIRST, tool",
  [subject],
);

describe("attack 1 — a grant for trigger A must not authorize trigger B", () => {
  beforeEach(resetFixture);

  it("keeps the grant scoped to (app, trigger) across a full store reload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-per-trigger-attack-"));
    const appId = "app_twin_reload";
    try {
      const first = await compose({ dataDir });
      try {
        await first.putApp(ADA.subject, twinDoc(appId));
        const armed = await first.automations.enable(appId, "alpha", ownerCtx(ADA.subject, appId));
        await approve(first, armed.missing);
        expect(await grantRows(first, ADA.subject)).toEqual([
          { tool: "host_invoices_update", app_id: appId, trigger_id: "alpha", source: "automation" },
        ]);
      } finally {
        await first.close();
      }

      // A COMPLETELY fresh engine + guard over the same database: nothing is
      // carried in memory, so what follows is read back off the row.
      const second = await compose({ dataDir });
      try {
        const ctx = ownerCtx(ADA.subject, appId);
        // Alpha's own grant survived the round trip — if `trigger_id` had been
        // dropped on persist this would still pass, so the next assert is the
        // one that separates the two.
        expect((await second.automations.enable(appId, "alpha", ctx)).missing).toEqual([]);
        // Beta's consent moment must still ask, after the reload.
        expect((await second.automations.enable(appId, "beta", ctx)).missing.map((r) => r.call.tool))
          .toEqual(["host_invoices_update"]);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses trigger B's away call while only trigger A is granted", async () => {
    const stack = await createStack();
    const appId = "app_twin_fire";
    try {
      await stack.putApp(ADA.subject, twinDoc(appId));
      const ctx = ownerCtx(ADA.subject, appId);
      await approve(stack, (await stack.automations.enable(appId, "alpha", ctx)).missing);

      // Beta is armed, and its asks are left PENDING — the documented state of a
      // partially granted automation, whose ungranted steps park at fire time.
      const beta = await stack.automations.enable(appId, "beta", ctx);
      expect(beta.missing).toHaveLength(1);

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

describe("attack 2 — a legacy app-wide grant must not widen to a new trigger", () => {
  beforeEach(resetFixture);

  /** Writes the app row EXACTLY as it sits in a deployment today: one `trigger`
   *  object, no trigger id anywhere. Raw SQL on purpose — the record door would
   *  normalize it on the way in. */
  const insertLegacyApp = async (stack: Stack, appId: AppId): Promise<void> => {
    const now = new Date().toISOString();
    await stack.sql(
      `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
       VALUES ($1, $2, false, $3::jsonb, $4, $4)`,
      [appId, ADA.subject, JSON.stringify({
        format: "vendo/app@1",
        id: appId,
        name: "Legacy twin",
        trigger: {
          on: { kind: "host-event", event: "legacy.main" },
          run: { kind: "steps", steps: [touchStep("legacy-main-ran")] },
        },
      }), now],
    );
  };

  /** The pre-S1 grant: an automation-source standing grant with an appId and NO
   *  trigger id, written through the same records door the guard mints through. */
  const insertLegacyGrant = async (stack: Stack, appId: AppId, tool: string): Promise<void> => {
    const descriptor = (await stack.bound.descriptors(ownerCtx(ADA.subject)))
      .find((candidate) => candidate.name === tool);
    if (descriptor === undefined) throw new Error(`fixture has no tool ${tool}`);
    const grant: PermissionGrant = {
      id: "grt_legacy_appwide",
      subject: ADA.subject,
      tool,
      descriptorHash: descriptorHash(descriptor),
      scope: { kind: "tool" },
      duration: "standing",
      appId,
      source: "automation",
      grantedAt: new Date().toISOString(),
    };
    await stack.store.records("vendo_grants").put({
      id: grant.id,
      data: grant,
      refs: { subject: grant.subject, tool: grant.tool, app_id: appId },
    });
  };

  it("reads the legacy grant as `main` and still asks for a trigger added later", async () => {
    const stack = await createStack();
    const appId = "app_legacy_widen_arm";
    try {
      await insertLegacyApp(stack, appId);
      await insertLegacyGrant(stack, appId, "host_invoices_update");
      // The row really is the pre-S1 shape.
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", app_id: appId, trigger_id: null, source: "automation" },
      ]);

      const ctx = ownerCtx(ADA.subject, appId);
      // Not WIDER, but not narrower either: the trigger it was minted for is the
      // one read normalization names `main`, so arming main re-asks for nothing.
      expect((await stack.automations.enable(appId, "main", ctx)).missing).toEqual([]);

      // A second trigger arrives on the same app, declaring the same tool.
      await stack.store.records("vendo_apps").put({
        id: appId,
        data: {
          subject: ADA.subject,
          enabled: false,
          doc: automationDoc({
            id: appId,
            name: "Legacy twin",
            triggers: [
              { id: "main", on: { kind: "host-event", event: "legacy.main" }, run: { kind: "steps", steps: [touchStep("legacy-main-ran")] } },
              { id: "extra", on: { kind: "host-event", event: "legacy.extra" }, run: { kind: "steps", steps: [touchStep("legacy-extra-ran")] } },
            ],
          }),
        },
        refs: { subject: ADA.subject },
      });
      // Arming it is a NEW consent moment: the legacy grant is not evidence
      // about a trigger that did not exist when it was minted.
      expect((await stack.automations.enable(appId, "extra", ctx)).missing.map((r) => r.call.tool))
        .toEqual(["host_invoices_update"]);
    } finally {
      await stack.close();
    }
  });

  it("refuses the new trigger's away call on the strength of the legacy grant", async () => {
    const stack = await createStack();
    const appId = "app_legacy_widen_fire";
    try {
      await insertLegacyApp(stack, appId);
      await insertLegacyGrant(stack, appId, "host_invoices_update");
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.store.records("vendo_apps").put({
        id: appId,
        data: {
          subject: ADA.subject,
          enabled: false,
          doc: automationDoc({
            id: appId,
            name: "Legacy twin",
            triggers: [
              { id: "main", on: { kind: "host-event", event: "legacy.main" }, run: { kind: "steps", steps: [touchStep("legacy-main-ran")] } },
              { id: "extra", on: { kind: "host-event", event: "legacy.extra" }, run: { kind: "steps", steps: [touchStep("legacy-extra-ran")] } },
            ],
          }),
        },
        refs: { subject: ADA.subject },
      });
      // Armed, asks left pending: nobody has allowed `extra` anything.
      expect((await stack.automations.enable(appId, "extra", ctx)).missing).toHaveLength(1);

      const [runId] = await stack.automations.emit("legacy.extra", { id: PROBE }, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);
      expect(run?.status).toBe("error");
      expect(run?.error?.code).toBe("needs-permission");
      expect(await probeMemo()).not.toBe("legacy-extra-ran");
    } finally {
      await stack.close();
    }
  });
});

describe("attack 2b — a pre-list STOPPED automation must not silently run again", () => {
  beforeEach(resetFixture);

  it("keeps a sponsorship row written before the rekey in force", async () => {
    const stack = await createStack();
    const appId = "app_legacy_stopped";
    try {
      // The whole pre-S1 on-disk state of an automation that STOPPED: armed
      // (enabled, no per-trigger armed row), holding its app-wide grant, and
      // carrying a sponsorship row a third party's edit invalidated. Every one of
      // these rows is keyed the way the shipped code keyed it — the app row's
      // single `trigger`, the grant's absent trigger id, and the sponsorship /
      // era rows' bare `appId` id.
      const now = new Date().toISOString();
      await stack.sql(
        `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
         VALUES ($1, $2, true, $3::jsonb, $4, $4)`,
        [appId, ADA.subject, JSON.stringify({
          format: "vendo/app@1",
          id: appId,
          name: "Legacy stopped",
          trigger: {
            on: { kind: "host-event", event: "legacy.stopped" },
            run: { kind: "steps", steps: [touchStep("stopped-ran")] },
          },
        }), now],
      );
      const descriptor = (await stack.bound.descriptors(ownerCtx(ADA.subject)))
        .find((candidate) => candidate.name === "host_invoices_update")!;
      await stack.store.records("vendo_grants").put({
        id: "grt_legacy_stopped",
        data: {
          id: "grt_legacy_stopped",
          subject: ADA.subject,
          tool: "host_invoices_update",
          descriptorHash: descriptorHash(descriptor),
          scope: { kind: "tool" },
          duration: "standing",
          appId,
          source: "automation",
          grantedAt: now,
        } satisfies PermissionGrant,
        refs: { subject: ADA.subject, tool: "host_invoices_update", app_id: appId },
      });
      await stack.store.records("automations:sponsorships").put({
        id: appId,
        data: {
          appId,
          sponsor: BOB.subject,
          intentHash: "sha256:whatever-it-was",
          status: "invalidated",
          reason: "edit",
          invalidatedAt: now,
        },
        refs: { subject: BOB.subject, app_id: appId },
      });
      await stack.store.records("automations:sponsored").put({
        id: appId,
        data: { appId, since: now },
        refs: { app_id: appId },
      });

      // A stopped automation does not run. The rekey must not hand it back to
      // the app's owner.
      const [runId] = await stack.automations.emit("legacy.stopped", { id: PROBE }, ADA);
      const run = runId === undefined
        ? undefined
        : await stack.automations.runs.get(runId, ownerCtx(ADA.subject, appId));
      expect(run?.status ?? "not-fired").not.toBe("ok");
      expect(await probeMemo()).not.toBe("stopped-ran");
      // …and the row is still stopped afterwards, not quietly revived.
      expect(await stack.sql<{ status: string }>(
        `SELECT data->>'status' AS status
           FROM vendo_records WHERE collection = 'automations:sponsorships' ORDER BY id`,
      )).toEqual([{ status: "invalidated" }]);
    } finally {
      await stack.close();
    }
  });
});

describe("attack 4 — one decision, one trigger, one mint", () => {
  beforeEach(resetFixture);

  it("cannot be replayed into a grant for the sibling trigger", async () => {
    const stack = await createStack();
    const appId = "app_replay";
    try {
      await stack.putApp(ADA.subject, twinDoc(appId));
      const ctx = ownerCtx(ADA.subject, appId);
      const alpha = await stack.automations.enable(appId, "alpha", ctx);
      const beta = await stack.automations.enable(appId, "beta", ctx);
      const alphaId = alpha.missing[0]!.id;
      expect(beta.missing[0]!.id).not.toBe(alphaId);

      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA);
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", app_id: appId, trigger_id: "alpha", source: "automation" },
      ]);

      // The same yes, decided again — a second mint here is a second authority.
      // A refusal (conflict) is the correct answer; what matters is the rows.
      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA).catch(() => undefined);
      await stack.guard.approvals.decide([alphaId], { approve: true }, ADA).catch(() => undefined);
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", app_id: appId, trigger_id: "alpha", source: "automation" },
      ]);
      // Beta's own ask is untouched and still pending.
      expect((await stack.guard.approvals.pending(ADA)).map((request) => request.id)).toEqual([beta.missing[0]!.id]);

      // Deciding BETA's ask mints beta's grant, and only beta's.
      await stack.guard.approvals.decide([beta.missing[0]!.id], { approve: true }, ADA);
      expect(await grantRows(stack, ADA.subject)).toEqual([
        { tool: "host_invoices_update", app_id: appId, trigger_id: "alpha", source: "automation" },
        { tool: "host_invoices_update", app_id: appId, trigger_id: "beta", source: "automation" },
      ]);
    } finally {
      await stack.close();
    }
  });
});

describe("attack 5 — two schedule triggers, one tick", () => {
  beforeEach(resetFixture);

  it("claims a cursor per (app, trigger) with no cross-claim and no double fire", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-per-trigger-tick-"));
    const appId = "app_two_schedules";
    const stack = await compose({ dataDir });
    try {
      const schedule = (id: string): Trigger => ({
        id,
        on: { kind: "schedule", every: "1m" },
        run: { kind: "steps", steps: [listStep] },
      });
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        name: "Two schedules",
        triggers: [schedule("early"), schedule("late")],
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await approve(stack, (await stack.automations.enable(appId, "early", ctx)).missing);
      await approve(stack, (await stack.automations.enable(appId, "late", ctx)).missing);

      // Each trigger got its OWN cursor row, keyed by the pair.
      expect((await stack.sql<{ id: string }>(
        "SELECT id FROM vendo_records WHERE collection = 'automations:schedule' ORDER BY id",
      ))).toEqual([{ id: `${appId}:early` }, { id: `${appId}:late` }]);

      // TWO authorities tick the same deployment at the same instant — the
      // claim is what stops one trigger from firing twice, or one trigger's
      // claim from swallowing the other's.
      const other = stack.extraEngine();
      const at = new Date(Date.now() + 180_000);
      const [mine, theirs] = await Promise.all([stack.automations.tick(at), other.tick(at)]);
      const fired = [...mine, ...theirs];
      expect(new Set(fired).size).toBe(fired.length);

      const runs = (await stack.automations.runs.list({ appId }, ctx)).runs;
      expect(runs.map((run) => run.triggerId).sort()).toEqual(["early", "late"]);
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

  it("refuses a chat grant and an mcp grant for every trigger of the app", async () => {
    const stack = await createStack({
      policy: { rules: [{ match: { tool: "host_invoices_update", venue: "chat" }, action: "ask" }] },
    });
    const appId = "app_source_check";
    try {
      // A REAL standing chat grant, minted the way a person mints one.
      const parked = await stack.bound.execute(
        { id: "call_chat_grant", tool: "host_invoices_update", args: { id: PROBE, memo: "chat-ran" } },
        ownerCtx(ADA.subject),
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

      await stack.putApp(ADA.subject, twinDoc(appId));
      const ctx = ownerCtx(ADA.subject, appId);
      // An mcp-source standing grant naming this very app AND this very trigger:
      // everything matches except the one thing that must decide it.
      const descriptor = (await stack.bound.descriptors(ctx))
        .find((candidate) => candidate.name === "host_invoices_update")!;
      const mcpGrant: PermissionGrant = {
        id: "grt_mcp_standing",
        subject: ADA.subject,
        tool: "host_invoices_update",
        descriptorHash: descriptorHash(descriptor),
        scope: { kind: "tool" },
        duration: "standing",
        appId,
        triggerId: "alpha",
        source: "mcp",
        grantedAt: new Date().toISOString(),
      };
      await stack.store.records("vendo_grants").put({
        id: mcpGrant.id,
        data: mcpGrant,
        refs: { subject: mcpGrant.subject, tool: mcpGrant.tool, app_id: appId },
      });

      // Both triggers armed, NOTHING approved for either.
      expect((await stack.automations.enable(appId, "alpha", ctx)).missing).toHaveLength(1);
      expect((await stack.automations.enable(appId, "beta", ctx)).missing).toHaveLength(1);
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
