import type { GrantId, PermissionGrant, VendoRecord } from "@vendoai/core";
import { descriptorHash } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

/**
 * A check used to list every grant the subject ever held and throw away the
 * wrong tools in JavaScript — one page per 1000 grants, every tool call. The
 * tool is an indexed column on the routed door, so the predicate belongs in the
 * query. This pins BOTH halves: the emitted SQL carries the tool, and the grant
 * the guard picks is the one the old JS filter would have picked.
 */

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

/** Every statement the store runs, in order. */
function recordSql(sqlStore: PGliteStore): string[] {
  const emitted: string[] = [];
  const real = sqlStore.db.query.bind(sqlStore.db);
  (sqlStore.db as unknown as { query: unknown }).query = (sql: string, params?: unknown[]) => {
    emitted.push(sql);
    return real(sql, params as never);
  };
  return emitted;
}

/** The filter that used to run in JavaScript over every one of the subject's
 *  grants, kept here as the equivalence oracle: whatever the query now selects
 *  must be what this would have selected off the unfiltered list. */
function jsFiltered(records: VendoRecord[], tool: string, fingerprint: string): PermissionGrant | undefined {
  const at = Date.now();
  for (const record of records) {
    const grant = record.data as PermissionGrant;
    const expiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
    if (grant.subject !== alice.subject) continue;
    if (grant.tool !== tool) continue;
    if (grant.revokedAt !== undefined) continue;
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= at)) continue;
    if (grant.descriptorHash !== fingerprint) continue;
    return grant;
  }
  return undefined;
}

describe("grants are filtered by tool in the query, not in JavaScript", () => {
  it("emits the tool predicate and picks exactly what the JS filter picked", async () => {
    const sqlStore = await store();
    // Several tools, and two same-tool grants that must lose on their own
    // merits — the filter has to keep answering those in JS.
    await seedGrant(sqlStore, { descriptor: descriptor("read") });
    await seedGrant(sqlStore, { descriptor: descriptor("destructive") });
    await seedGrant(sqlStore, {
      descriptor: descriptor("write"),
      id: "grt_revoked",
      revokedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await seedGrant(sqlStore, {
      descriptor: descriptor("write"),
      id: "grt_expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const live = await seedGrant(sqlStore, { descriptor: descriptor("write"), id: "grt_live" });

    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(new FixtureTools());
    const write = call("host_write", { invoiceId: "inv_1" }, "call_grant");
    const emitted = recordSql(sqlStore);

    await expect(bound.execute(write, context())).resolves.toMatchObject({ status: "ok" });

    // The tool rode the query. Every grants list the check ran carries it — a
    // single unfiltered one would be the whole drawer coming back.
    const listed = emitted.filter((sql) => sql.includes("FROM vendo_grants") && sql.includes("subject ="));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((sql) => /tool = \$\d+/.test(sql))).toBe(true);

    // …and the grant it decided by is the one the old JS filter would have
    // chosen off the unfiltered list.
    const all = await sqlStore.records("vendo_grants").list({ refs: { subject: alice.subject } });
    const expected = jsFiltered(all.records, "host_write", descriptorHash(descriptor("write")));
    expect(expected?.id).toBe(live.id);
    await expect(guard.check(write, descriptor("write"), context())).resolves.toEqual({
      action: "run",
      decidedBy: "grant",
      grantId: expected?.id,
    });
  });

  /** The grant is not a decision input the way a rule is — it IS the authority
   *  the call executes on, and the preview-to-dispatch gap is exactly the
   *  window the kill switch's own re-read comment (guard.ts, `bind().execute`)
   *  exists to close. A permission taken back inside that window must bite
   *  there too, so the grants are read again for the real pass. */
  it("refuses a call whose grant was revoked between the preview and the real call", async () => {
    const sqlStore = await store();
    const grant = await seedGrant(sqlStore, { descriptor: descriptor("destructive") });
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const destructive = call("host_destructive", { invoiceId: "inv_2" }, "call_revoked");

    // The SDK previews first: the standing grant answers, so nothing pauses.
    await expect(
      guard.previewCheck!(destructive, descriptor("destructive"), context()),
    ).resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    // …and the person takes the permission back before the dispatch.
    await guard.grants.revoke(grant.id as GrantId, alice);

    // The real pass has to see that. Without the grant, a destructive call
    // needs a human — it parks, and the tool never runs.
    await expect(bound.execute(destructive, context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });
});
