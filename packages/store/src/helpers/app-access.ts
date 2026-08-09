import {
  VendoError,
  accessForPath,
  grantMatches,
  holdsLevel,
  parseGrantPrincipal,
  strongerLevel,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
  type AppId,
  type CanThing,
  type IsoDateTime,
  type Membership,
  type RunContext,
} from "@vendoai/core";
import type { VendoStore } from "../store.js";

/** Build contract §9.3 — the SHAPES and the PURE rules (the principal grammar,
 *  the level order, the path rules) live in core, so the apps runtime's test
 *  stand-in resolves access through the very same functions; only the ROW
 *  reading is here, because only the store can do it. */
export type { AccessLevel, AppAccess, AppGrantRecord, CanThing, GrantPrincipal } from "@vendoai/core";
export { isGrantPrincipal, orgOfPath, parseGrantPrincipal } from "@vendoai/core";

const membershipIn = (ctx: RunContext, org: string): Membership | undefined =>
  (ctx.memberships ?? []).find((entry) => entry.org === org);

/** How many grant rows one query reads. Sizing, not a limit — `grantsFor` pages
    to the end, because a level that stops applying at row 501 is a permission
    bug that leaves no trace. */
const GRANT_PAGE_SIZE = 500;

/**
 * Build contract §9.3 — `can()`, one function, three doors (the workspace
 * façade, the wire, and the MCP door all reach it through the apps runtime).
 *
 * It is OSS and NEVER key-conditional: with no Cloud key no grant row can be
 * written, so it simply degenerates to "is it yours?" (§9.6). Memberships come
 * from the ctx ONLY — the host asserted them this request and `can()` never
 * queries an org chart, because Vendo does not have one (§9.1).
 *
 * Everything goes through the ADAPTER interface (`store.records`), never raw
 * SQL: multi-party deployments are exactly the ones running on a hosted store,
 * which has no local db handle.
 */
export function appAccess(store: VendoStore): AppAccess {
  const grants = store.records("vendo_app_grants");
  const apps = store.records("vendo_apps");

  const rowSubject = async (appId: AppId): Promise<string | undefined> => {
    const record = await apps.get(appId);
    return record === null ? undefined : record.refs?.["subject"];
  };

  const recordOf = (record: {
    id: string;
    data: unknown;
    createdAt: IsoDateTime;
  }): AppGrantRecord => {
    const data = record.data as Omit<AppGrantRecord, "id" | "createdAt">;
    return { ...data, id: record.id, createdAt: record.createdAt };
  };

  /** EVERY grant on the app, paged. One page (the overwhelming case) is one
   *  query — the door only returns a cursor when more rows exist — and the
   *  501st grant resolves like the first, instead of silently granting nothing
   *  to whoever happened to fall off the end of the page. */
  const grantsFor = async (appId: AppId): Promise<AppGrantRecord[]> => {
    const rows: AppGrantRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await grants.list({
        refs: { app_id: appId },
        limit: GRANT_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      rows.push(...page.records.map(recordOf));
      cursor = page.cursor;
    } while (cursor !== undefined);
    return rows;
  };

  /**
   * THE UNIQUENESS RULE this file depends on: `vendo_apps.subject` holds EITHER
   * a person's subject OR an org id (§9.5 — promote writes the org id verbatim),
   * with no discriminator column. Every resolution below reads it both ways in
   * the same breath — `subject === ctx.principal.subject` means ownership,
   * `membershipIn(ctx, subject)` means org-admin — so a host that issues an org
   * id equal to some person's subject makes that person the owner of the org's
   * apps. The rule is therefore a HOST INVARIANT: org ids and user subjects
   * share one namespace and must be unique across it.
   *
   * Not fixed in code deliberately: a discriminator means a v8 column, a
   * backfill of every existing app row, and a widening of every subject-keyed
   * query and index in the store (apps, state, threads, audit, workspace
   * `owner`, the erase cascade's `subject = $1` rule, promote's row flip) —
   * a schema-train change, not a permission fix.
   */
  const levelFor = async (ctx: RunContext, appId: AppId): Promise<AccessLevel | null> => {
    const subject = await rowSubject(appId);
    if (subject === undefined) return null;
    // Ownership, then org-admin: an admin of the org that HOLDS the row is an
    // implicit owner of every app in it (§9.3).
    if (subject === ctx.principal.subject) return "owner";
    let level: AccessLevel | null = membershipIn(ctx, subject)?.admin === true ? "owner" : null;
    for (const row of await grantsFor(appId)) {
      if (grantMatches(ctx, row.principal)) level = strongerLevel(level, row.level);
    }
    return level;
  };

  /** §9.4 posture in one place: a caller who cannot even view stays masked with
      `not-found`; a proven viewer denied a stronger action gets `forbidden`. */
  const require = async (ctx: RunContext, appId: AppId, level: AccessLevel): Promise<void> => {
    const held = await levelFor(ctx, appId);
    if (held === null) throw new VendoError("not-found", `app not found: ${appId}`);
    if (!holdsLevel(held, level)) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
  };

  const can = async (ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean> => {
    if ("path" in thing) {
      // core decides everything a path decides without rows; what is left is the
      // one case that needs them — an app's own subtree, governed by its grants.
      const resolved = accessForPath(ctx, level, thing.path);
      return "app" in resolved ? await can(ctx, level, { app: resolved.app }) : resolved.decision;
    }
    return holdsLevel(await levelFor(ctx, thing.app), level);
  };

  return {
    can,
    levelFor,

    async grant(ctx, appId, principal, level) {
      // §9.2's grammar is checked HERE, by the door, before anything is written
      // — and not ONLY in the local engine's row validator, which a hosted or
      // BYO records adapter never runs. That validator refused an
      // unparseable principal (`parseAppGrantData`) and the hosted store posted
      // it straight to the console, so the same share was refused on Postgres
      // and accepted on Cloud's own default; which store is wired may never
      // change behaviour (the adapter rule). A principal that cannot be parsed
      // cannot be matched by `grantMatches` either, so accepting one wrote a row
      // that granted nobody anything — after the app had already been moved into
      // the team to make room for it.
      const named = parseGrantPrincipal(principal);
      if (named === undefined) {
        throw new VendoError(
          "validation",
          `"${principal}" is not a principal — sharing needs "user:<subject>",`
          + ` "team:<orgId>/<teamId>", or "org:<orgId>"`,
        );
      }
      await require(ctx, appId, "owner");
      const orgId = await rowSubject(appId);
      // §9.2 — `org_id` is "the org whose workspace holds the app", so a
      // team:/org: principal from anywhere else can never be satisfied: the
      // matcher keys on the org that HOLDS the row. Storing it anyway would
      // show a share in the list that grants nothing.
      if (named.kind !== "user" && named.org !== orgId) {
        throw new VendoError(
          "validation",
          `this app is not in ${named.org}'s workspace, so ${named.org} cannot be given access to it`
          + ` — move the app into ${named.org} first (sharing offers to), then share it`,
        );
      }
      // Design spec §8 — "live sharing implies the org workspace", and the
      // 2026-08-01 ruling applies it to EVERY principal. A `user:` grant on a
      // still-personal app resolves to a real level and then finds nothing: the
      // app's documents live under the holder's `/user` mount, and no `/user`
      // path is ever another person's (core's `accessForPath`). The app has to
      // move into an org first — which is what the Share dialog now does before
      // it writes the grant. Two exceptions, both real: the holder's own row
      // (promote mints it BEFORE the flip, §9.5), and an app an asserted
      // membership says is already held by an org.
      if (named.kind === "user" && named.subject !== orgId && membershipIn(ctx, orgId ?? "") === undefined) {
        throw new VendoError(
          "validation",
          "this app is still one person's, so another person cannot be given access to it"
          + " — move it into a team first (sharing offers to), or fork a copy for them",
        );
      }
      // ONE row per (app, principal), enforced HERE rather than by the local
      // engine's `ON CONFLICT (app_id, principal)` — a constraint no hosted or
      // BYO records adapter has, and `records.put` is keyed by id alone. A
      // second row for one principal is an unrevokable grant: `levelFor` folds
      // every match with `strongerLevel`, so a downgrade does nothing, and
      // `revoke` would have to find them all.
      //
      // The id for a principal that has no row yet is DERIVED, exactly as core's
      // reference adapter derives it, and never minted. Reading first and then
      // minting is a read-then-write window: two overlapping grants both read
      // "no row", both mint a random id, and the pair is back — an authorization
      // write racing itself. A derived id makes the whole write ONE put on ONE
      // key, which is the only shape that is atomic on an adapter interface
      // offering no transaction; the overlap collapses to last-write-wins on a
      // single row, which is a state some serial order also produces.
      //
      // The FOUND id still wins when there is one, and that is the migration
      // property: every grant already on disk carries a random id, and a derived
      // id would sit BESIDE it rather than replacing it. The local engine keeps
      // its own id through `ON CONFLICT (app_id, principal) DO UPDATE`, which
      // never writes the id column, so nothing already stored is re-keyed.
      const existing = (await grantsFor(appId)).find((row) => row.principal === principal);
      await grants.put({
        id: existing?.id ?? `ag_${appId}_${principal}`,
        data: { appId, orgId, principal, level, createdBy: ctx.principal.subject },
        // The door writes the refs it queries by. The local engine derives them
        // from the row's own columns, but an adapter that stores records
        // generically (the hosted door, any BYO adapter) keeps only what it was
        // given — and `grantsFor` lists by `app_id`, so a grant written without
        // refs there is a grant nothing can ever read back. Same reason the
        // effect ledger passes `refs: { subject }` (guard.ts #recordEffect).
        refs: { app_id: appId, ...(orgId === undefined ? {} : { org_id: orgId }), principal, level },
      });
    },

    async revoke(ctx, appId, principal) {
      await require(ctx, appId, "owner");
      // EVERY matching row, not the first: an adapter that accreted duplicates
      // before `grant` reused ids would otherwise keep the person granted, and
      // a revoke that leaves access standing is the worst possible outcome here.
      const matching = (await grantsFor(appId)).filter((row) => row.principal === principal);
      for (const row of matching) await grants.delete(row.id);
    },

    async list(ctx, appId) {
      await require(ctx, appId, "viewer");
      return await grantsFor(appId);
    },
  };
}
