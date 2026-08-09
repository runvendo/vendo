/**
 * The doors over the app RECORD itself: reading it, listing it, opening it,
 * calling into it, its history, and the four ways a copy of it travels
 * (fork/export/import/share/publish) plus the one way the canonical app does
 * (promote).
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  encodeGrantPrincipal,
  type AppDocument,
} from "@vendoai/core";
import { createAgentTools } from "./agent-tools.js";
import { allRecords } from "./access-checks.js";
import { appRecordInput, documentFromRecord, rowFromRecord, withoutSession } from "./persistence.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type { AppsRuntime } from "./types.js";

const createAppReadDoors = (
  deps: Pick<AppsRuntimeContext,
    "config" | "caller" | "history" | "review" | "opener" | "owned" | "requireOwned"
    | "grantedRecords">,
): Pick<AppsRuntime, "get" | "list" | "history" | "open" | "call"> => {
  const { config, caller, history, review, opener, owned, requireOwned } = deps;
  const { grantedRecords } = deps;
  return {
    async get(appId, ctx) {
      const app = await owned(appId, ctx, "viewer");
      return app === null ? null : withoutSession(app);
    },

    async list(ctx) {
      const records = await allRecords(config.store, { subject: ctx.principal.subject });
      // Build contract §9.3 — owned ∪ granted. The grant rows already name the
      // apps this caller reaches, so the union is one extra id fetch rather
      // than a scan; `can()` still decides each one (a grant to a team the
      // caller is not in this request does not match).
      const granted = await grantedRecords(ctx, new Set(records.map((record) => record.id)));
      records.push(...granted);
      const documents: AppDocument[] = [];
      for (const record of records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))) {
        try {
          const document = documentFromRecord(record);
          // A terminally failed build is a tombstone open() reads to resolve
          // the embed — not a real app; it never joins the listable surface.
          if (document.buildFailed !== undefined) continue;
          documents.push(withoutSession(document));
        } catch {
          // Corrupt rows cannot be surfaced, but must not hide valid owned apps.
        }
      }
      return documents;
    },

    /**
     * Build contract §9.3 — the level lives HERE, not only at the wire route
     * that used to be the sole boundary: reading the log needs `viewer`, and a
     * caller who cannot even see the app stays masked (`not-found`), exactly
     * like every other door. The 06 §1 signature gained the ctx for this
     * reason (wave-3 ruling).
     */
    history(appId, ctx) {
      const surface = history.surface(appId);
      return Object.freeze({
        list: async () => {
          await requireOwned(appId, ctx, "viewer");
          return await surface.list();
        },
      });
    },

    async open(appId, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      // Review-kind (2026-08-02): an unapproved current version is invisible —
      // open() serves the newest APPROVED version from the existing history
      // instead (or the pending state when none was ever approved). Instant
      // kind passes through untouched.
      return opener(await review.serveDocFor(app), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      // A host-tool ref goes straight to the guard-bound registry; an fn: ref
      // settles as a contained not-implemented outcome until the in-runtime
      // fn path lands (see call.ts).
      //
      // A READ takes the QUERY arm. This is the only door a code-land app has
      // (@vendoai/ui/kit's useToolQuery), so sending every call through the action
      // arm gave a read a random uuid per invocation — and the guard's approved
      // replay PINS the call id (05 §2), so an ungraded read that parked could
      // never be satisfied: approve, refetch, new id, park again, forever.
      // `callQuery` derives the id from (app, tool, args), which is exactly a
      // query's identity. The discriminator is the tool's own authored risk
      // grade, the server's existing classification of what a call does;
      // everything else keeps the action arm, because two identical mutations
      // are two separate acts and each has to earn its own approval.
      const descriptor = (await config.tools.descriptors(ctx).catch(() => []))
        .find((candidate) => candidate.name === ref);
      return descriptor?.risk === "read"
        ? caller.callQuery(app, ref, args, ctx)
        : caller.call(app, ref, args, ctx);
    },
  };
};

const createAppCopyDoors = (
  deps: Pick<AppsRuntimeContext, "config" | "apps" | "interchange" | "requireOwned" | "reportLifecycle">,
): Pick<AppsRuntime, "fork" | "exportApp" | "importApp" | "share" | "publish"> => {
  const { config, apps, interchange, requireOwned, reportLifecycle } = deps;
  return {
    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx, "viewer");
      // Wave 4 — a served (layer-3) app's ENTIRE surface lives in its machine,
      // and machines never travel with a copy: the fork would be an app that
      // can never open (ui: http, no tree, no machine). Refuse loudly instead
      // of minting a broken document. Scoped to machine-backed docs — a
      // retired v1 `server`-ref doc keeps its established fork semantics (the
      // copy drops the dead ref; see the 09 §3 wire test).
      if (source.ui === "http" && source.machine !== undefined) {
        throw new VendoError(
          "conflict",
          "a served (layer-3) app cannot be forked: its surface lives in its machine, which never travels with a copy — create a new app instead",
        );
      }
      const fork: AppDocument = {
        ...structuredClone(source),
        id: `app_${globalThis.crypto.randomUUID()}`,
        forkedFrom: source.id,
      };
      // execution-v2 — a fork never carries the machine; the copy re-graduates
      // on its own.
      delete fork.machine;
      // Lane E grant hygiene — egress approval never travels with a copy; the
      // fork re-approves its declaration.
      delete fork.egressApproved;
      // The conversation belongs to the owner who had it, not to the copy: the
      // persist already drops it (appRecordInput takes no session here), and the
      // RETURNED document must not hand it back either.
      await apps.put(appRecordInput(fork, ctx.principal.subject));
      await reportLifecycle("fork", fork.id, ctx, { sourceAppId: source.id });
      return withoutSession(structuredClone(fork));
    },

    async exportApp(appId, ctx) {
      return interchange.exportApp(appId, ctx);
    },

    async importApp(source, ctx) {
      return interchange.importApp(source, ctx);
    },

    async share(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — a share copy never carries the owner's egress
      // approval; whoever runs the copy approves its declaration themselves.
      // …and the brain's conversation never travels either: it is the owner's
      // transcript, not part of the app.
      const { egressApproved: _egressApproved, ...shared } = app;
      return config.cloud.share(appId, withoutSession(shared));
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — same rule as share: approval never travels.
      const { egressApproved: _published, ...published } = app;
      return config.cloud.publish(appId, withoutSession(published));
    },
  };
};

const createPromoteDoor = (
  deps: Pick<AppsRuntimeContext, "config" | "apps" | "requireOwned" | "requireMultiParty" | "reportLifecycle">,
): AppsRuntime["promote"] => {
  const { config, apps, requireOwned, requireMultiParty, reportLifecycle } = deps;
  return async (appId, orgId, ctx) => {
    requireMultiParty("promote");
    const app = await requireOwned(appId, ctx, "owner");
    // The host asserted this request's orgs; promoting into one you are not
    // in is the same refusal shape as any other over-reach on a visible app.
    if (!(ctx.memberships ?? []).some((membership) => membership.org === orgId)) {
      throw new VendoError(
        "forbidden",
        `you are not a member of ${orgId}, so this app cannot be promoted into it`,
      );
    }
    const from = (await apps.get(appId))?.refs?.subject;
    if (from === undefined) throw new VendoError("not-found", `app not found: ${appId}`);
    if (from === orgId) return withoutSession(structuredClone(app));
    if (config.promoteApp === undefined) {
      // Build contract §9.5, ruled 2026-08-01: promote is BYO-store-only for
      // now. A promote crosses subjects AND moves workspace rows, which needs
      // a local engine handle the Cloud-hosted store does not have — a
      // hosted-store promote door is Cloud-console work. The refusal stays
      // LOUD and never half-moves an app; it names the limit and the fix so
      // nobody has to read this comment to get unstuck.
      throw new VendoError(
        "cloud-required",
        "moving an app into a team workspace isn't available on the hosted store yet — "
        + "wire your own Postgres with createVendo({ store: createStore({ url }) }) to move it, "
        + "or share a copy with fork instead",
      );
    }
    // "Share implies promote", so the promoter must not lock themselves out
    // of the app they just handed over. Minted BEFORE the flip, because
    // afterwards the row belongs to the org and the owner gate on `grant`
    // would have nothing to admit them by — the promoter is not necessarily
    // an org admin.
    const promoter = encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject });
    // Mint-then-KNOW: what the promoter held BEFORE this call, so a failure
    // takes back exactly what this call added and nothing else. Inferring it
    // afterwards cannot tell "I minted this" from "someone else did".
    const heldBefore = (await config.appAccess?.list(ctx, appId))
      ?.find((row) => row.principal === promoter)?.level;
    await config.appAccess?.grant(ctx, appId, promoter, "owner");
    // The row's subject becomes the org id VERBATIM — the same convention the
    // workspace `owner` column uses (contract §3.3), so one id names the app's
    // rows and its documents alike, and the documents move with it.
    try {
      await config.promoteApp(appId, from, orgId);
    } catch (failure) {
      // All-or-nothing means undoing what THIS call did — and only that. If
      // the row no longer names `from`, a concurrent promote won: the grant
      // now admits the promoter to the app that just moved, and revoking it
      // would lock her out of her own app.
      if ((await apps.get(appId))?.refs?.subject === from && config.appAccess !== undefined) {
        const undo = heldBefore === undefined
          ? config.appAccess.revoke(ctx, appId, promoter)
          : config.appAccess.grant(ctx, appId, promoter, heldBefore);
        await undo.catch(() => undefined);
      }
      throw failure;
    }
    // Re-stamped now that the row names the org, so the grant's `org_id`
    // records the org that actually holds the app (one row per (app,
    // principal), so this updates in place rather than accreting).
    await config.appAccess?.grant(ctx, appId, promoter, "owner");
    // An automation runs with a PERSON's access — their connections, their
    // secrets, their name in the audit log — and there is no org principal to
    // run as (inventing one would run it as a synthetic user named after the
    // org). The person who armed it may not even be in the team. So the move
    // DISARMS it, the same law an edited trigger already follows; re-enabling
    // mints a fresh sponsorship under whoever turns it back on.
    const moved = await apps.get(appId);
    const movedRow = moved === null ? null : rowFromRecord(moved);
    const disarmed = movedRow?.enabled === true;
    if (disarmed) {
      await apps.put(appRecordInput(movedRow.doc, orgId, false));
    }
    await reportLifecycle("promote", appId, ctx, { orgId, from, ...(disarmed ? { disarmed } : {}) });
    return withoutSession(structuredClone(app));
  };
};

/** The app-record slice of `AppsRuntime`. */
export const createAppsSurface = (
  deps: Pick<AppsRuntimeContext,
    "config" | "apps" | "caller" | "data" | "history" | "review" | "opener" | "interchange"
    | "inClientApprovals" | "egressApprovals" | "parkedActions" | "placementRows"
    | "lifecycle" | "owned" | "requireOwned" | "requireMultiParty"
    | "grantedRecords" | "reportLifecycle" | "claimSlot" | "markUnbuilt"
    | "runtime">,
): Pick<AppsRuntime,
  "get" | "list" | "delete" | "fork" | "promote" | "share" | "publish"
  | "exportApp" | "importApp" | "history" | "open" | "call" | "agentTools"> => {
  const { config, apps, data, history, review, inClientApprovals } = deps;
  const { egressApprovals, parkedActions, placementRows, lifecycle } = deps;
  const { requireOwned, reportLifecycle, claimSlot, markUnbuilt, runtime } = deps;
  return {
    ...createAppReadDoors(deps),
    ...createAppCopyDoors(deps),
    promote: createPromoteDoor(deps),
    async delete(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      // execution-v2 — deleting the app reaps its machine (live sandbox +
      // stored snapshot) directly, without rewriting the doomed document: a
      // graduated tree's fn: refs would fail a machine-cleared re-validation
      // and otherwise strand the provider snapshot.
      await lifecycle.destroyResources(app);
      await data.clear(app, ctx.principal.subject, await history.documents(appId));
      await history.clear(appId);
      await inClientApprovals.clear(appId);
      await review.clear(appId);
      await egressApprovals.clearForApp(appId);
      await parkedActions.clearForApp(appId);
      await apps.delete(appId);
      // A deleted app can never mount again, so its placement rows are dead
      // weight — and a row with no app record reads as a build in flight, which
      // would park a skeleton in the slot until the build window elapsed and
      // then a failure card over the host's own markup. Swept by APP, not by
      // the deleter's subject: a shared app sits in slots belonging to people
      // the deleter cannot enumerate, and those pages are the ones that would
      // be left holding it.
      await placementRows.clearForApp(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    agentTools() {
      return createAgentTools(runtime(), {
        data,
        requireOwned,
        claimSlot,
        markUnbuilt,
        ...(config.screen === undefined ? {} : { screen: config.screen }),
        ...(config.escalatedPlan === undefined ? {} : { escalatedPlan: config.escalatedPlan }),
      });
    },
  };
};
