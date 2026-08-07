/**
 * Build contract §9.2–§9.4 — the ONE permission check and the postures built on
 * it, lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  encodeGrantPrincipal,
  type AccessLevel,
  type AppAccess,
  type AppDocument,
  type AppId,
  type RecordStore,
  type RunContext,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { documentFromRecord, listAllRecords } from "./persistence.js";
import type { AppsConfig } from "./types.js";

export const allRecords = (store: StoreAdapter, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllRecords(store.records("vendo_apps"), { refs });

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

export const createAccessChecks = (deps: { config: AppsConfig; apps: RecordStore }) => {
  const { config, apps } = deps;
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
    const record = known === undefined ? await apps.get(appId) : known;
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
    const record = await apps.get(appId);
    if (record === null || !(await holds(appId, ctx, level, record))) return null;
    return documentFromRecord(record);
  };

  /** Build contract §9.6 — the ONE Cloud gate on this block. Sharing is
      multi-party coordination, so the writes that create it need a key; the
      enforcement half (`can()`) is OSS and never key-conditional, which is why
      only these three verbs consult this. */
  const requireMultiParty = (what: string): void => {
    if (config.multiParty !== true) {
      throw new VendoError(
        "cloud-required",
        `${what} needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store) — apps you own alone keep working without it`,
      );
    }
  };

  /** Only the WRITE verbs reach this: an unwired seam is an absence, and the
      reads (`levelFor`, `list`) report it as ownership + an empty list rather
      than as something to go buy. */
  const requireAccess = (): AppAccess => {
    if (config.appAccess === undefined) {
      throw new VendoError("cloud-required", "this deployment has no app-access store wired");
    }
    return config.appAccess;
  };

  /** The app rows this caller reaches WITHOUT owning them: their grant rows,
      plus every app held by an org they administer (implicit owner, §9.3).
      `can()` re-decides each one — this only narrows what to ask about. */
  const grantedRecords = async (ctx: RunContext, already: Set<string>): Promise<VendoRecord[]> => {
    if (config.appAccess === undefined) return [];
    const ids = new Set<string>();
    const found: VendoRecord[] = [];
    for (const principal of grantPrincipalsOf(ctx)) {
      for (const row of await listAllRecords(config.store.records("vendo_app_grants"), { refs: { principal } })) {
        const appId = (row.data as { appId?: string }).appId;
        if (appId !== undefined && !already.has(appId)) ids.add(appId);
      }
    }
    for (const membership of ctx.memberships ?? []) {
      if (membership.admin !== true) continue;
      for (const row of await allRecords(config.store, { subject: membership.org })) {
        if (!already.has(row.id)) found.push(row);
      }
    }
    for (const record of await listAllRecords(apps, { ids: [...ids] })) {
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

  return { holds, owned, requireOwned, requireMultiParty, requireAccess, grantedRecords };
};
