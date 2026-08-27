/**
 * Placement (2026-08-05) — "show this app in that slot", as a ROW keyed by
 * (subject, slot). The three doors, and the two writes the BUILD makes into a
 * slot before an app record exists.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  buildInFlight,
  effectiveAppBuildUiDeadlineMs,
  refuseBundleArtifact,
} from "../../contract/index.js";
import { APPS_COLLECTION, appRecordInput, updateAppRow } from "../persistence/persistence.js";
import type { PlacementRow } from "../persistence/placements.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, PlacementEntry } from "../runtime/types.js";

/** The slot bookkeeping a build does before there is an app record to place. */
export const createPlacementRows = (
  deps: Pick<AppsRuntimeContext, "engine" | "placementRows" | "holds" | "reportLifecycle">,
) => {
  const { engine, placementRows, holds, reportLifecycle } = deps;
  /** A slot name is host-authored and arrives from a wire body or a tool call,
   *  so it is checked here — the one place every caller passes through. */
  const requireSlot = (slot: string): string => {
    const trimmed = slot.trim();
    if (trimmed.length === 0) throw new VendoError("validation", "slot must be a non-empty string");
    return trimmed;
  };

  /**
   * B1 — the slot is claimed the moment the id EXISTS, so it shows the build
   * forming (and, if it never lands, its failure) instead of sitting empty
   * until the app record does. `place()` cannot be used: it gates on an app
   * record, and by construction there is none yet.
   *
   * Two callers, one write: `create` for a build that mints its own id, and the
   * `vendo_make` front door for the id it minted before it routed. Whichever
   * engine the ask reaches, the row is already down.
   */
  const claimSlot = async (appId: AppId, slot: string, ctx: RunContext): Promise<void> => {
    const named = requireSlot(slot);
    await placementRows.put(ctx.principal.subject, {
      slot: named,
      appId,
      placedBy: ctx.principal.subject,
      placedAt: new Date().toISOString(),
    });
    await reportLifecycle("place", appId, ctx, { slot: named });
  };

  /**
   * The terminal record for an id no engine will ever land — the front door's
   * own, for an ask that died in assembly.
   *
   * The SAME tombstone a failed build leaves (`failBuild`, inside `create`), and
   * that is the whole point: `entryFor` below reads one thing, so a claimed slot
   * turns into the honest failure card the instant either engine gives up rather
   * than holding a skeleton until the build window ages out.
   */
  const markUnbuilt = async (
    appId: AppId,
    name: string,
    reason: string,
    ctx: RunContext,
  ): Promise<void> => {
    await engine.put(APPS_COLLECTION, appRecordInput({
      format: "vendo/app@1",
      id: appId,
      name,
      buildFailed: { reason, at: new Date().toISOString() },
    }, ctx.principal.subject, false, "screen-agent"));
  };

  /**
   * The ids an assembler is running for right now — what tells a screen's first
   * painting save that it belongs to a BUILD, which is not finished when it first
   * paints, rather than to a harness writing `app.tsx` straight through the
   * workspace, which is. Per-process, which is exactly why the save persists
   * `AppDocument.building` onto the row: the poll that reads it back is a
   * different request, often a different process.
   */
  const buildsInFlight = new Set<AppId>();
  const beginBuild = (appId: AppId): void => { buildsInFlight.add(appId); };
  const buildingNow = (appId: AppId): boolean => buildsInFlight.has(appId);

  /**
   * `markUnbuilt`'s LIVE twin — the assembler came back, however it came back, so
   * the row may mount. Its one caller is the wrapper `createRuntimeContext` puts
   * around `assemble` itself, which is why no door has to remember to call it.
   */
  const settleBuild = async (appId: AppId): Promise<void> => {
    buildsInFlight.delete(appId);
    // Read before write: every EDIT runs the assembler too (`assembleEdit`), and
    // an unconditional rewrite would put this door on top of every edit's own
    // save. It clears only a mark it made.
    const record = await engine.get(APPS_COLLECTION, appId).catch(() => null);
    const doc = (record?.data as { doc?: { building?: unknown } } | null)?.doc;
    if (doc?.building === undefined) return;
    await updateAppRow(engine, appId, (next) => {
      delete next.building;
      return next;
    }, "screen-agent").catch(() => undefined);
  };

  /** Where a placed app's build stands, read off its record every time.
   *
   *  NO RECORD is the build still running — the slot is claimed at mint and the
   *  app record lands at the build's first painting save. A row that carries
   *  `building` is that same build, still writing. Past the UI build window
   *  neither is forming any more: either the watchdog would have landed a
   *  terminal record by now, or the app was deleted out from under the row, and
   *  a slot that says "building" forever is the exact failure the build watchdog
   *  exists to prevent. */
  const entryFor = async (row: PlacementRow, ctx: RunContext): Promise<PlacementEntry | undefined> => {
    const record = await engine.get(APPS_COLLECTION, row.appId);
    if (record === null) {
      const forming = Date.now() - Date.parse(row.placedAt) < effectiveAppBuildUiDeadlineMs();
      return { slot: row.slot, app: row.appId, title: "", status: forming ? "building" : "failed" };
    }
    // §9.4, on the placement read too: a placement names a DOCUMENT, so its
    // title and its live build status are that document's to mask. A viewer
    // whose grant was taken back reads the slot as empty, exactly as
    // open()/get()/list() have already gone back to not-found for them.
    if (!(await holds(row.appId, ctx, "viewer", record))) return undefined;
    // Two fields off the raw row, deliberately without document validation:
    // one unparseable app must not take down every other slot's answer (the
    // same read the wire's ?pending=1 probe does).
    const doc = (record.data as { doc?: { name?: unknown; buildFailed?: unknown; building?: unknown } } | null)?.doc;
    const failed = doc?.buildFailed !== undefined && doc.buildFailed !== null;
    return {
      slot: row.slot,
      app: row.appId,
      title: typeof doc?.name === "string" ? doc.name : "",
      status: failed ? "failed" : buildInFlight(typeof doc?.building === "string" ? doc.building : undefined)
        ? "building"
        : "ready",
    };
  };

  return { requireSlot, claimSlot, markUnbuilt, beginBuild, buildingNow, settleBuild, entryFor };
};

/** The placement slice of `AppsRuntime`. */
export const createPlacementSurface = (
  deps: Pick<AppsRuntimeContext,
    "placementRows" | "requireOwned" | "requireSlot" | "entryFor" | "reportLifecycle">,
): Pick<AppsRuntime, "place" | "unplace" | "placements"> => {
  const { placementRows, requireOwned, requireSlot, entryFor, reportLifecycle } = deps;
  return {
    async place(input, ctx) {
      const slot = requireSlot(input.slot);
      // Viewer: seeing the app is enough to put it in your own slot. This also
      // masks an app the caller cannot see (§9.4) before any row is written.
      refuseBundleArtifact(await requireOwned(input.app, ctx, "viewer"), "placed in a slot");
      const subject = ctx.principal.subject;
      const previous = await placementRows.place(subject, {
        slot,
        appId: input.app,
        placedBy: subject,
        placedAt: new Date().toISOString(),
      });
      const evicted = previous !== undefined && previous.appId !== input.app ? previous.appId : undefined;
      await reportLifecycle("place", input.app, ctx, {
        slot,
        ...(evicted === undefined ? {} : { evicted }),
      });
      return evicted === undefined ? {} : { evicted };
    },

    async unplace(input, ctx) {
      const slot = requireSlot(input.slot);
      const subject = ctx.principal.subject;
      const row = await placementRows.get(subject, slot);
      // Not this app's slot (any more): nothing to clear, and clearing what
      // replaced it would be a silent eviction nobody asked for. The store's
      // delete is scoped to the same app, so a place that lands between this
      // read and that write keeps the slot.
      if (row === undefined || row.appId !== input.app) return;
      await placementRows.delete(subject, slot, input.app);
      await reportLifecycle("unplace", input.app, ctx, { slot });
    },

    async placements(input, ctx) {
      // The SAME normalization every write goes through. Trimming on one side
      // only means `placements({ slots: [" hero "] })` cannot see what
      // `place(" hero ")` wrote.
      const rows = await placementRows.list(ctx.principal.subject, input.slots?.map(requireSlot));
      const entries = await Promise.all(rows.map((row) => entryFor(row, ctx)));
      return entries.filter((entry): entry is PlacementEntry => entry !== undefined);
    },
  };
};
