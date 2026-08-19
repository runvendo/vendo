/**
 * Build contract §9.2–§9.3 — `AppsRuntime.access`: what level the CALLER holds
 * on an app, and the grant writes the ✦ share toggle needs.
 *
 * The LEVEL lives here, not on the wire, so the MCP door inherits the same
 * rules without a second copy: `list` needs viewer, grant/revoke need owner.
 * `config.appAccess` is set unconditionally from the composed store, so the
 * seam is always present under `createVendo`.
 */
import { VendoError, encodeGrantPrincipal, parseGrantPrincipal, type AppId, type RunContext } from "@vendoai/core";
import { APPS_COLLECTION } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";

export type AccessSurfaceDeps = Pick<AppsRuntimeContext, "config" | "engine" | "holds">;

export const createAccessSurface = ({ config, engine, holds }: AccessSurfaceDeps): AppsRuntime["access"] => {
  /** §9.4's posture in one place: what the caller cannot VIEW stays not-found;
      a proven viewer denied a stronger action gets forbidden. */
  const require = async (appId: Parameters<AppsRuntime["access"]["list"]>[0], ctx: Parameters<AppsRuntime["access"]["list"]>[1], level: "viewer" | "owner") => {
    if (await holds(appId, ctx, level)) return;
    if (level !== "viewer" && await holds(appId, ctx, "viewer")) {
      throw new VendoError("forbidden", `owner access is required for ${appId}`);
    }
    throw new VendoError("not-found", `app not found: ${appId}`);
  };
  /**
   * "Share implies promote" (ruled 2026-08-01, pinned at
   * conformance/app-access.ts:181-201). Every create path stamps an app with the
   * PERSON, and core refuses a tenant grant on a still-personal app — the app's
   * documents live under the holder's own `/user` mount, so a share that skipped
   * the move would hand the recipient an empty app. So the share moves it first,
   * in `lifecycle.promote`'s one transaction.
   *
   * ORDER IS THE WHOLE POINT. The move restamps the row's subject as the org id,
   * which retires the promoter's ownership fast path (access-checks.ts:65) — so
   * an owner who is not a tenant ADMIN would lose the app she just shared. Her
   * own owner grant is therefore minted BEFORE the flip, the deliberate
   * exception pinned at store helpers/app-access.ts:186-188.
   *
   * With no `ops` (a store offering neither its own ops nor a SQL handle) there
   * is nothing to move with, and core's own refusal below is the honest answer.
   */
  const promoteBeforeSharing = async (appId: AppId, principal: string, ctx: RunContext) => {
    const target = parseGrantPrincipal(principal);
    if (target === undefined || target.kind === "user" || config.ops === undefined) return;
    const record = await engine.get(APPS_COLLECTION, appId);
    if (record?.refs?.["subject"] === target.org) return;
    await config.appAccess!.grant(
      ctx,
      appId,
      encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject }),
      "owner",
    );
    await config.ops.lifecycle.promote(appId, target.org);
  };

  const access: AppsRuntime["access"] = {
    async levelFor(appId, ctx) {
      if (config.appAccess === undefined) {
        // No seam ⇒ no grant row can exist, so ownership is the only level —
        // which is exactly what `holds` degenerates to, at one store read.
        return await holds(appId, ctx, "owner") ? "owner" : null;
      }
      return await config.appAccess.levelFor(ctx, appId);
    },
    async list(appId, ctx) {
      await require(appId, ctx, "viewer");
      // No seam ⇒ no grant row can exist, so the empty list is the honest
      // answer, not a refusal telling a keyless deployment to go buy something.
      return config.appAccess === undefined ? [] : await config.appAccess.list(ctx, appId);
    },
    async grant(appId, principal, level, ctx) {
      await require(appId, ctx, "owner");
      await promoteBeforeSharing(appId, principal, ctx);
      await config.appAccess!.grant(ctx, appId, principal, level);
      return await access.list(appId, ctx);
    },
    async revoke(appId, principal, ctx) {
      await require(appId, ctx, "owner");
      await config.appAccess!.revoke(ctx, appId, principal);
      // The revoke LANDED. A caller who just removed their own last grant may
      // no longer read it — that is §9.4 answering a different question, not a
      // failed removal, so answer with what they can still legitimately see.
      return await access.list(appId, ctx).catch((reason: unknown) => {
        if (reason instanceof VendoError && (reason.code === "not-found" || reason.code === "forbidden")) return [];
        throw reason;
      });
    },
  };
  return access;
};
