/**
 * Build contract §9.2–§9.4 — the ONE permission check and the postures built on
 * it, lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  encodeGrantPrincipal,
  type AccessLevel,
  type AppId,
  type RunContext,
  type VendoRecord,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import type { EngineOps } from "../persistence/engine.js";
import { APPS_COLLECTION, documentFromRecord, listAllEngineRecords } from "../persistence/persistence.js";
import type { AppsConfig } from "../runtime/types.js";

/** The grant rows the app-access door reads; one drawer, its own name. */
const APP_GRANTS_COLLECTION = "vendo_app_grants";

export const allRecords = (engine: EngineOps, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllEngineRecords(engine, APPS_COLLECTION, { refs });

/** Build contract §9.2 — the grant-principal encodings THIS ctx satisfies.
    Derived from the asserted memberships alone, so a team the host did not
    assert this request simply is not in the list. Through core's ONE encoder,
    so a query here can never miss a shape a surface wrote. */
const grantPrincipalsOf = (ctx: RunContext): string[] => {
  const encodings = [encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject })];
  for (const membership of ctx.memberships ?? []) {
    encodings.push(encodeGrantPrincipal({ kind: "org", org: membership.org }));
    for (const team of membership.teams ?? []) {
      encodings.push(encodeGrantPrincipal({ kind: "team", org: membership.org, team }));
    }
  }
  return encodings;
};

export const createAccessChecks = (deps: { config: AppsConfig; engine: EngineOps }) => {
  const { config, engine } = deps;
  /**
   * Build contract §9.3 — the ONE permission check, widened rather than
   * duplicated: the wire and the MCP door reach it through this runtime.
   *
   * Level rules: reads need `viewer`, edits `editor`, delete/share `owner`.
   * With no `appAccess` wired (the OSS single-player default) it degenerates to
   * exactly what it always was — row ownership, at every level.
   */
  const holds = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel,
    /** The row, when the caller already read it — `open()` and `get()` are on
        every render, so the single-player path must stay ONE read. */
    known?: VendoRecord | null,
  ): Promise<boolean> => {
    const record = known === undefined ? await engine.get(APPS_COLLECTION, appId) : known;
    // The owner fast path. Ownership is the TOP level, so the row the caller
    // already read answers every level for its own subject — no grants query,
    // no second read. This is what keeps get()/open() at ONE store read on the
    // single-player path even with `can()` wired (which is always, under the
    // umbrella).
    if (record?.refs?.subject === ctx.principal.subject) return true;
    if (config.appAccess === undefined) return false;
    return await config.appAccess.can(ctx, level, { app: appId });
  };

  const owned = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel = "editor",
  ): Promise<AppDocument | null> => {
    const record = await engine.get(APPS_COLLECTION, appId);
    if (record === null || !(await holds(appId, ctx, level, record))) return null;
    return documentFromRecord(record);
  };

  /** The app rows this caller reaches WITHOUT owning them: their grant rows,
      plus every app held by an org they administer (implicit owner, §9.3).
      `can()` re-decides each one — this only narrows what to ask about. */
  const grantedRecords = async (ctx: RunContext, already: Set<string>): Promise<VendoRecord[]> => {
    if (config.appAccess === undefined) return [];
    const ids = new Set<string>();
    const found: VendoRecord[] = [];
    for (const principal of grantPrincipalsOf(ctx)) {
      for (const row of await listAllEngineRecords(engine, APP_GRANTS_COLLECTION, { refs: { principal } })) {
        const appId = (row.data as { appId?: string }).appId;
        if (appId !== undefined && !already.has(appId)) ids.add(appId);
      }
    }
    for (const membership of ctx.memberships ?? []) {
      if (membership.admin !== true) continue;
      for (const row of await allRecords(engine, { subject: membership.org })) {
        if (!already.has(row.id)) found.push(row);
      }
    }
    for (const record of await listAllEngineRecords(engine, APPS_COLLECTION, { ids: [...ids] })) {
      if (!found.some((row) => row.id === record.id)) found.push(record);
    }
    // The grant/admin sets can overlap the caller's own rows only through a
    // doctored row; `can()` below is still the authority on every one of them.
    const visible: VendoRecord[] = [];
    for (const record of found) {
      if (await holds(record.id, ctx, "viewer")) visible.push(record);
    }
    return visible;
  };

  /** §9.4's posture in one place: what the caller cannot even VIEW stays
      `not-found` (existence-masking, as ever); a proven viewer denied a
      stronger action gets `forbidden`, which is what the fork offer renders. */
  const requireOwned = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel = "editor",
  ): Promise<AppDocument> => {
    const app = await owned(appId, ctx, level);
    if (app !== null) return app;
    if (level !== "viewer" && await holds(appId, ctx, "viewer")) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
    throw new VendoError("not-found", `app not found: ${appId}`);
  };

  return { holds, owned, requireOwned, grantedRecords };
};
