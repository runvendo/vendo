import type { AuditEvent, ToolDescriptor } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import {
  alice,
  auditEvent,
  call,
  context,
  descriptor,
  FixtureTools,
  seedGrant,
} from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of source) lines.push(line);
  return lines;
}

describe("audit persistence, query, and export", () => {
  it("audits ok, blocked, parked, and grant-run outcomes in the public SQL table", async () => {
    const sqlStore = await store();
    const granted: ToolDescriptor = descriptor("write", { name: "host_granted" });
    await seedGrant(sqlStore, { descriptor: granted, appId: "app_1", id: "grt_audit" });
    const tools = new FixtureTools([...new FixtureTools().available, granted]);
    const guard = createGuard({
      store: sqlStore,
      policy: {
        rules: [
          { match: { tool: "host_write" }, action: "block", note: "writes disabled" },
          { match: { tool: "host_destructive" }, action: "ask" },
        ],
      },
    });
    const bound = guard.bind(tools);
    const ctx = context({ venue: "app", appId: "app_1" });

    await expect(bound.execute(call("host_read", {}, "audit_ok"), ctx)).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(call("host_write", {}, "audit_block"), ctx)).resolves.toEqual({
      status: "blocked",
      reason: "writes disabled",
    });
    await expect(bound.execute(call("host_destructive", {}, "audit_park"), ctx)).resolves.toMatchObject({
      status: "pending-approval",
    });
    await expect(bound.execute(call("host_granted", {}, "audit_grant"), ctx)).resolves.toMatchObject({ status: "ok" });

    const rows = await sqlStore.query<{
      kind: string;
      subject: string;
      app_id: string;
      tool: string | null;
      outcome: string | null;
      decided_by: string | null;
      grant_id: string | null;
    }>(`SELECT kind, subject, app_id, tool,
               event->>'outcome' AS outcome,
               event->>'decidedBy' AS decided_by,
               event->'detail'->>'grantId' AS grant_id
        FROM vendo_audit`);
    expect(rows.rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool-call", subject: alice.subject, app_id: "app_1", tool: "host_read", outcome: "ok", decided_by: "default", grant_id: null }),
        expect.objectContaining({ kind: "tool-call", tool: "host_write", outcome: "blocked", decided_by: "rule" }),
        expect.objectContaining({ kind: "tool-call", tool: "host_destructive", outcome: "pending-approval", decided_by: "rule" }),
        // Audit enrichment: a grant-decided run records WHICH grant decided it.
        expect.objectContaining({ kind: "tool-call", tool: "host_granted", outcome: "ok", decided_by: "grant", grant_id: "grt_audit" }),
      ]),
    );
  });

  it("audits the actAs subject-mismatch error outcome for a grant-decided away call", async () => {
    const sqlStore = await store();
    const probe: ToolDescriptor = descriptor("write", { name: "host_probe" });
    await seedGrant(sqlStore, {
      descriptor: probe,
      appId: "app_1",
      source: "automation",
      id: "grt_actas",
    });
    const tools = new FixtureTools([probe]);
    // Actions never self-authorizes (04-actions): a grant/principal subject
    // mismatch surfaces as an error OUTCOME, not an exception. The guard must
    // land that outcome in the audit trail so the refusal is visible beyond
    // the return value — alongside the grant that authorized the attempt.
    tools.setOutcome("host_probe", {
      status: "error",
      error: { code: "act-as-subject-mismatch", message: "Grant subject does not match the acting principal" },
    });
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(tools);
    const ctx = context({ venue: "automation", presence: "away", appId: "app_1" });

    await expect(bound.execute(call("host_probe", {}, "audit_actas"), ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "act-as-subject-mismatch" },
    });

    const rows = await sqlStore.query<{ outcome: string | null; decided_by: string | null; grant_id: string | null }>(
      `SELECT event->>'outcome' AS outcome,
              event->>'decidedBy' AS decided_by,
              event->'detail'->>'grantId' AS grant_id
       FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'host_probe'`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ outcome: "error", decided_by: "grant", grant_id: "grt_actas" }),
    ]);
  });

  it("lifts the connector account identity off the outcome into the audit detail", async () => {
    const sqlStore = await store();
    const tools = new FixtureTools();
    // A connector attaches its account identity as the outcome passthrough
    // `connectorAccount` (04-actions §3 / cross-cutting audit enrichment).
    tools.setOutcome("host_read", {
      status: "ok",
      output: { sent: true },
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: alice.subject },
    } as never);
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(tools);

    const outcome = await bound.execute(call("host_read", {}, "audit_connector"), context());
    // The identity is audit enrichment, not model/UI payload: stripped here.
    expect(outcome).toEqual({ status: "ok", output: { sent: true } });

    const rows = await sqlStore.query<{ detail: string | null }>(
      `SELECT event->>'detail' AS detail FROM vendo_audit WHERE tool = 'host_read'`,
    );
    const detail = JSON.parse(rows.rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.connectorAccount).toEqual({ connector: "composio", toolkit: "gmail", entityId: alice.subject });
  });

  it("lifts the actAs disposition off the outcome into the audit detail (ENG-263)", async () => {
    const sqlStore = await store();
    const tools = new FixtureTools();
    // The actAs seam tags its disposition as the outcome passthrough `actAs`
    // (block-actions design §C — "declined" is away re-verification failing closed).
    tools.setOutcome("host_read", {
      status: "error",
      error: { code: "not-implemented", message: "the host declined away execution for this action" },
      actAs: "declined",
    } as never);
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(tools);

    const outcome = await bound.execute(call("host_read", {}, "audit_actas"), context());
    // The disposition is audit enrichment, not model/UI payload: stripped here.
    expect(outcome).toEqual({
      status: "error",
      error: { code: "not-implemented", message: "the host declined away execution for this action" },
    });

    const rows = await sqlStore.query<{ detail: string | null }>(
      `SELECT event->>'detail' AS detail FROM vendo_audit WHERE tool = 'host_read'`,
    );
    const detail = JSON.parse(rows.rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.actAs).toBe("declined");
  });

  it("audits org context (org principal + actor) on org-owned executions (ENG-263)", async () => {
    const sqlStore = await store();
    const tools = new FixtureTools();
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(tools);

    const orgCtx = {
      ...context(),
      principal: { kind: "org" as const, subject: "vendo:org:org_1", display: "Acme" },
      actor: alice,
    };
    await expect(bound.execute(call("host_read", {}, "audit_org"), orgCtx)).resolves.toMatchObject({ status: "ok" });

    const rows = await sqlStore.query<{ subject: string; detail: string | null }>(
      `SELECT subject, event->>'detail' AS detail FROM vendo_audit WHERE tool = 'host_read'`,
    );
    expect(rows.rows[0]?.subject).toBe("vendo:org:org_1");
    const detail = JSON.parse(rows.rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.org).toEqual({ subject: "vendo:org:org_1", actor: alice.subject });
  });

  it("audits connect-required connector outcomes with their identity", async () => {
    const sqlStore = await store();
    const tools = new FixtureTools();
    tools.setOutcome("host_read", {
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect gmail" },
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: alice.subject },
    } as never);
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(tools);

    const outcome = await bound.execute(call("host_read", {}, "audit_connect"), context());
    expect(outcome).toEqual({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect gmail" },
    });

    const rows = await sqlStore.query<{ outcome: string | null; detail: string | null }>(
      `SELECT event->>'outcome' AS outcome, event->>'detail' AS detail FROM vendo_audit WHERE tool = 'host_read'`,
    );
    expect(rows.rows[0]?.outcome).toBe("connect-required");
    const detail = JSON.parse(rows.rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.connectorAccount).toMatchObject({ connector: "composio", toolkit: "gmail" });
  });

  it("filters inclusively and pages with the underlying opaque cursor", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const events: AuditEvent[] = [
      auditEvent({ id: "aud_1", at: "2026-01-01T00:00:00.000Z", kind: "tool-call", tool: "host_read", appId: "app_1" }),
      auditEvent({ id: "aud_2", at: "2026-01-02T00:00:00.000Z", kind: "approval", tool: "host_write", appId: "app_1" }),
      auditEvent({ id: "aud_3", at: "2026-01-03T00:00:00.000Z", kind: "tool-call", tool: "host_write", appId: "app_2" }),
      auditEvent({ id: "aud_4", at: "2026-01-04T00:00:00.000Z", kind: "tool-call", tool: "host_read", appId: "app_1" }),
    ];
    for (const event of events) await guard.report(event);

    const filtered = await guard.audit.query({
      principal: alice,
      appId: "app_1",
      kind: "tool-call",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-04T00:00:00.000Z",
    });
    expect(filtered.events.map((event) => event.id)).toEqual(["aud_4", "aud_1"]);

    const first = await guard.audit.query({ principal: alice, limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.cursor).toBeDefined();
    const second = await guard.audit.query({ principal: alice, limit: 2, cursor: first.cursor });
    expect(second.events).toHaveLength(2);
    expect(new Set([...first.events, ...second.events].map((event) => event.id))).toEqual(
      new Set(events.map((event) => event.id)),
    );
  });

  it("exports full, parseable newline-delimited JSON and honors time bounds", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    await guard.report(auditEvent({ id: "aud_old", at: "2025-12-31T00:00:00.000Z" }));
    await guard.report(auditEvent({ id: "aud_in_1", at: "2026-01-01T00:00:00.000Z" }));
    await guard.report(auditEvent({ id: "aud_in_2", at: "2026-01-02T00:00:00.000Z" }));

    const lines = await collect(
      guard.audit.export({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" }),
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["aud_in_2", "aud_in_1"]);
  });

  it("treats equivalent UTC bounds as the same instant regardless of ISO precision", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    await guard.report(auditEvent({ id: "aud_boundary", at: "2026-01-01T00:00:00.000Z" }));

    // Bound written without milliseconds: string compare would drop the event,
    // instant compare keeps it.
    const inclusive = await guard.audit.query({
      principal: alice,
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z",
    });
    expect(inclusive.events.map((event) => event.id)).toEqual(["aud_boundary"]);
  });

  it("does not special-case ephemeral principals", async () => {
    const sqlStore = await store();
    const ephemeral = { kind: "user" as const, subject: "anon_1", ephemeral: true };
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(new FixtureTools());
    await bound.execute(call("host_read", {}, "ephemeral_call"), context({ principal: ephemeral }));

    const result = await guard.audit.query({ principal: ephemeral });
    expect(result.events).toEqual([
      expect.objectContaining({ principal: ephemeral, kind: "tool-call", outcome: "ok" }),
    ]);
  });
});
