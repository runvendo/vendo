/**
 * `AppsRuntime.seed` — the ✦ fork, starting from the splitter's ported source.
 *
 * A remix is not a subsystem. It is a `create` that starts from something that
 * already existed, so this module is thin on purpose: it finds the captured
 * baseline, SEEDS that baseline's ported source as the new app's own `app.tsx`,
 * records what the person asked for, and hands the ordinary edit door the
 * instruction. Standard validation, standard edit path, standard history.
 *
 * THE PORT IS THE POINT. A fork whose first edit starts from an empty file is not
 * a fork of anything — it is a fresh generation wearing the component's name. So
 * the ported source lands FIRST, through the ordinary checks floor, and the
 * person's wishes are then edits OF THE COMPONENT'S REAL CODE. Fork plus first
 * edit are still ONE operation, and its output is still a regular screen
 * (`app.tsx`, through the ordinary edit door). The captured baseline is
 * provenance: what the remix started from, and what a re-seed replays the
 * recorded wishes against.
 *
 * A baseline with no `ported` half was not provably splittable. It gets NO remix
 * and, upstream of here, no ✦ at all: the chrome offers the gesture only on the
 * slots the generated wiring names. A direct call is refused at the lookup,
 * before anything is minted — never a fallback that regenerates the component
 * from scratch.
 */
import {
  VendoError,
  safeErrorMessage,
  type AppId,
  type Json,
  type RunContext,
} from "@vendoai/core";
import {
  seedDrift,
  type AppDocument,
  type SeedBaseline,
  type SeedDrift,
  type SeedPort,
} from "../../contract/index.js";
import { APPS_COLLECTION, appRecordInput, onAppRow } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, SeedFromInput, VersionEntry } from "../runtime/types.js";

export type SeedSurfaceDeps = Pick<
  AppsRuntimeContext,
  | "config"
  | "engine"
  | "history"
  | "placementRows"
  | "requireOwned"
  | "persistEdit"
  | "failedEdit"
  | "reportLifecycle"
  | "rungFor"
  | "runtime"
  | "replaySources"
>;

/** A baseline with its ported half — the only kind a remix can start from, and
 *  the type says so, so no path below can reach for a port that is not there. */
type PortedBaseline = SeedBaseline & { ported: SeedPort };

/** The one lookup, and the one refusal. A component the splitter could not port
 *  has nothing for a fork to START from, so it is no more remixable than one
 *  nobody captured — regenerating it from scratch would hand the person a
 *  different component wearing this one's name. Both refusals land HERE, before
 *  anything is minted, so a remix that cannot exist leaves no row behind. The
 *  chrome never offers the ✦ on one of these (the generated wiring names only
 *  the slots that ported), and sync already said why in its report; this is what
 *  a direct API caller gets, as an ordinary reportable wire error. */
const baselineFor = (deps: SeedSurfaceDeps, component: string): PortedBaseline => {
  const baseline = (deps.config.seedBaselines ?? []).find(({ slot }) => slot === component);
  if (baseline === undefined) {
    throw new VendoError(
      "not-found",
      `remixable component "${component}" has no captured baseline; wrap it in <Remixable> and run vendo sync`,
    );
  }
  if (baseline.ported === undefined) {
    throw new VendoError(
      "validation",
      `host component "${baseline.slot}" has no ported source, so it cannot be remixed; `
      + "run vendo sync and read its report for why this component could not be ported",
    );
  }
  return baseline as PortedBaseline;
};

/**
 * Lay a port down as the app's own `app.tsx`, through the ORDINARY checks floor.
 *
 * The floor's own `ok` is what stores a screen (`authoredScreen`, via
 * `AppFloorOptions.delivered`), so this is a real paint on the real gauntlet —
 * the same one `vendo sync` graded this port with, which is why a blessed port
 * passes here. A refusal is loud and terminal for the caller: storing nothing
 * quietly is how an app ships that cannot be opened.
 */
const seedScreen = async (
  deps: SeedSurfaceDeps,
  appId: AppId,
  baseline: PortedBaseline,
  ctx: RunContext,
): Promise<void> => {
  const painted = await deps.runtime().floor(ctx).component({ appId, source: baseline.ported.source });
  if (!painted.ok) {
    throw new VendoError(
      "validation",
      `the ported "${baseline.slot}" did not pass the checks floor: ${painted.blocking.join("; ")}`,
      { appId },
    );
  }
};

/**
 * The ✦ gesture: seed the port, record the provenance, then run the person's
 * instruction through the ordinary edit door. What comes back is an ordinary
 * screen app that happens to know where it came from.
 */
const seedFrom = async (
  deps: SeedSurfaceDeps,
  input: SeedFromInput,
  ctx: RunContext,
): Promise<AppDocument> => {
  const baseline = baselineFor(deps, input.component);
  // Idempotent per (subject, component): the gesture dedupes SERVER-side, so a
  // double-tap can never mint two apps and the chrome's latch stays cosmetic.
  // The OLDEST matching row wins, which is the same winner the chrome's own
  // `.at(-1)` discovery converges on.
  const seededAlready = (app: AppDocument): boolean => app.seed?.component === input.component;
  const existing = (await deps.runtime().list(ctx)).filter(seededAlready).at(-1);
  // A riding instruction is dropped on a dedupe hit: the tap that created the
  // app already carried one, and this app is that tap's answer.
  if (existing !== undefined) return existing;
  const minted: AppDocument = {
    format: "vendo/app@1",
    id: `app_${globalThis.crypto.randomUUID()}`,
    name: `${baseline.slot} remix`,
    ui: "tree",
    seed: {
      component: baseline.slot,
      baseline: baseline.hash,
      wishes: [input.instruction],
      ...(input.slot === undefined ? {} : { slot: input.slot }),
      ...(baseline.review === undefined ? {} : { review: baseline.review }),
    },
  };
  // The row goes down BEFORE the port's paint because the paint builds on it:
  // the floor's row half clones this document forward into the screen it stores
  // (`screenDocument`, doors/write-surface.ts), so a port painted first would
  // land an app with no provenance on it.
  await deps.engine.put(APPS_COLLECTION, appRecordInput(minted, ctx.principal.subject, false, "seed"));
  // The version that says where this app came from. `seed.from` is the one
  // create that does not go through `persistEdit`, so it is the one create that
  // has to append its own — without it a remix arrives with no history at all.
  await deps.history.append(minted.id, minted, {
    at: new Date().toISOString(),
    intent: `Remix the host component "${baseline.slot}"`,
    rung: deps.rungFor(minted),
  });
  if (input.slot !== undefined) {
    // "Show the remix in THIS slot" is a placement ROW. The seed on the
    // document is provenance, never location.
    await deps.placementRows.put(ctx.principal.subject, {
      slot: input.slot,
      appId: minted.id,
      placedBy: ctx.principal.subject,
      placedAt: new Date().toISOString(),
    });
  }
  await deps.reportLifecycle("create", minted.id, ctx);
  // The pre-mint check is list-then-put, so two concurrent gestures can both
  // find nothing and both mint. Close the race after the write: if an OLDER app
  // also carries this seed, the just-minted row deletes itself and the older one
  // wins. List order is deterministic, so both racers pick the same winner and
  // only the loser deletes.
  const oldest = (await deps.runtime().list(ctx)).filter(seededAlready).at(-1);
  if (oldest !== undefined && oldest.id !== minted.id) {
    await deps.runtime().delete(minted.id, ctx);
    return oldest;
  }
  // Re-read the stored row: the edit below builds on the store's own JSON round
  // trip, never on the in-memory original.
  const stored = await deps.requireOwned(minted.id, ctx);
  // A refused port or a failed instruction never hands the caller an error over
  // an app that already exists — it leaves the terminal marker every other
  // failed build leaves. `open()` then answers `failed` instead of pending
  // forever, and `list()` skips the row, so the next ✦ tap mints a fresh app
  // instead of deduping onto this failed one. `edit()` THROWS only when no model is
  // wired and RETURNS its common failure, hence both arms.
  let reason: string;
  try {
    // The PORT, first: the app opens on the component's real code from this
    // moment, and the instruction below is an EDIT of it rather than an author
    // starting from an empty file.
    await seedScreen(deps, stored.id, baseline, ctx);
    // A paint names an app after its screen's own export (`screenName`, through
    // `authoredScreen`), which would rename this remix out of the `<slot> remix`
    // the mint chose two dozen lines up. Seeding the port is not an authoring
    // act and nothing asked for a new name, so the mint's name goes back before
    // the instruction runs. Skipped when they already agree, for the reason
    // `authoredScreen` skips an unchanged save: a write that changes nothing.
    //
    // READ AND WRITE TAKE A TURN ON THE ROW (`onAppRow`), because this put
    // carries the WHOLE document it read: a courier landing in the window
    // between them was carried straight back off, and the remix silently stopped
    // following the host page — nothing refused, nothing logged.
    await onAppRow(minted.id, async () => {
      const painted = await deps.requireOwned(minted.id, ctx);
      if (painted.name !== minted.name) {
        await deps.engine.put(
          APPS_COLLECTION,
          appRecordInput({ ...painted, name: minted.name }, ctx.principal.subject, false, "seed"),
        );
      }
    });
    // A concurrent write to this row — the ✦ door landing a RACING gesture's
    // wish is the common one, and seeding the port first widened that window —
    // is not a failed build: the row moved, so run the instruction once more
    // against it. A conflict that persists means someone is ACTIVELY editing
    // this remix; the port stands and the row is alive, so hand it back as it
    // is rather than marking a working remix `buildFailed` — the ✦ door
    // re-lands its own wish whenever it finds it missing from the list.
    const conflicted = (error: unknown): boolean => error instanceof VendoError && error.code === "conflict";
    const attempt = () => deps.runtime().edit(stored.id, input.instruction, ctx);
    let edited;
    try {
      edited = await attempt();
      // A RETURNED failure is the same race in its other jacket: the edit door
      // wraps "app changed under this save" as `failure` rather than throwing.
      // Nothing persists on a failure, so one more try against the moved row
      // is safe — a genuine refusal just fails twice and lands below.
      if (edited.failure !== undefined) edited = await attempt();
    } catch (error) {
      if (!conflicted(error)) throw error;
      try {
        edited = await attempt();
      } catch (secondError) {
        if (!conflicted(secondError)) throw secondError;
        return await deps.requireOwned(minted.id, ctx);
      }
    }
    if (edited.failure === undefined) return edited.app;
    reason = (edited.issues ?? []).join("; ") || edited.failure.message;
  } catch (error) {
    reason = safeErrorMessage(error);
  }
  // Over the row as it stands NOW, never over the pre-seed copy above: the port
  // painted through the floor and the floor STORED it, so marking the failure on
  // the older document would quietly revert the app's screen back out of it.
  // Reading it inside a turn (`onAppRow`) is the same "NOW" one step finer — a
  // courier landing between this read and its put would be reverted by it.
  return onAppRow(minted.id, async () => {
    const failed: AppDocument = {
      ...await deps.requireOwned(minted.id, ctx),
      buildFailed: { reason, retryable: true, at: new Date().toISOString(), prompt: input.instruction },
    };
    await deps.engine.put(APPS_COLLECTION, appRecordInput(failed, ctx.principal.subject, false, "seed"));
    return failed;
  });
};

/**
 * The re-seed: the host shipped a new version of the component, so run EVERY
 * recorded wish against it, oldest first.
 *
 * The whole list, because the remix is the whole list — replaying only the ask
 * it was forked with would silently undo every edit made since. A wish the new
 * version cannot take is kept and reported (`seed.unapplied`, which the re-seed
 * tool says out loud), never dropped.
 */
const reseed = async (
  deps: SeedSurfaceDeps,
  input: { appId: AppId },
  ctx: RunContext,
): Promise<AppDocument> => {
  const app = await deps.requireOwned(input.appId, ctx);
  const seed = app.seed;
  if (seed === undefined) {
    throw new VendoError("conflict", `app ${input.appId} was not created from a host component`);
  }
  const baseline = baselineFor(deps, seed.component);
  if (baseline.hash === seed.baseline) {
    throw new VendoError("conflict", `${seed.component} has not changed since this app was created`);
  }
  // The host's NEW port is what the replay starts from — that is the whole
  // point of an update, and replaying onto the stored pristine copy would
  // rebuild the person's changes on the component they are trying to leave.
  // Published for this replay only, and NEVER painted into the row: each
  // wish's own save is the landing, so a replay that does not land leaves the
  // person's screen exactly where it was. Cleared in `finally` because a replay
  // that throws must not leave a port behind for the next ordinary edit of this
  // app to pick up.
  //
  // The replay goes FIRST and the provenance moves only once something has
  // landed: `edit()` reports the common failure in `failure` rather than
  // throwing, so rebasing ahead of it left the OLD screen claiming the host's
  // current version — no drift warning, and every retry refused as a conflict
  // above.
  deps.replaySources.set(app.id, baseline.ported.source);
  const unapplied: string[] = [];
  let replayed = app;
  try {
    for (const wish of seed.wishes) {
      const edited = await deps.runtime().edit(app.id, wish, ctx);
      if (edited.failure === undefined) replayed = edited.app;
      else unapplied.push(wish);
    }
  } finally {
    deps.replaySources.delete(app.id);
  }
  // Nothing landed when EVERY wish failed, so the provenance stays where it is
  // and the version says so: the remix never reached the host's new version,
  // and the drift warning has to survive for the retry. The report is written
  // either way — this used to return early, which dropped the whole list on the
  // one run where the person most needs to hear which wishes were left behind.
  const anyLanded = unapplied.length < seed.wishes.length;
  const nextBaseline = anyLanded ? baseline.hash : seed.baseline;
  // The report REPLACES the previous run's rather than adding to it: a wish that
  // lands this time has stopped being one to report.
  const rebased = {
    ...replayed,
    seed: { ...seed, baseline: nextBaseline, unapplied: unapplied.length === 0 ? undefined : unapplied },
  };
  const version: VersionEntry = {
    at: new Date().toISOString(),
    intent: anyLanded
      ? `Update ${seed.component} to the host's current version`
      : `Update ${seed.component}: no recorded wish could be replayed`,
    rung: deps.rungFor(rebased),
  };
  const landed = await deps.persistEdit(replayed, rebased, version, ctx.principal.subject, { origin: "seed" });
  await deps.reportLifecycle("reseed", app.id, ctx, {
    component: seed.component,
    fromBaseline: seed.baseline,
    toBaseline: nextBaseline,
  });
  return landed;
};

/**
 * The COURIER: record the live props of the host instance this remix stands in
 * for.
 *
 * A ported screen renders FROM ITS PROPS, and a query resolves before the render,
 * so nothing in the screen's own source can carry them. With none recorded the
 * checks floor paints the port on the baseline's captured `sampleProps` — the
 * values frozen the day `vendo sync` ran — and the remix shows that number
 * forever while the host's own component beside it shows today's.
 *
 * This is PROVENANCE, not content. It writes `seed.props` and touches nothing
 * else: no version is minted, no wish is recorded and no edit door is entered,
 * because the person did not change their remix — their page did. That is also
 * why it is safe to call on every render the props really change on.
 *
 * THE BOUNDARY is the captured baseline's own declared prop names. The wrapper
 * ships whatever the host's call site passed, so a value the component never
 * declared — anything the page happened to hang on that element — is dropped
 * HERE, before it is stored, rather than being filtered at each of the places
 * that later read the seed. A baseline that captured no props declares none and
 * so admits none: never invented, exactly like the paint it feeds.
 *
 * READ AND WRITE TAKE A TURN ON THE ROW (`onAppRow`). Being provenance rather
 * than an edit is exactly what makes this dangerous: it writes whenever the host
 * re-renders, including all the way through a ✦ mint's build, and a save cannot
 * tell this write from an edit that would revert it — so landing inside one's
 * window refused it as `app changed under this save`, one mint in three.
 */
const courierProps = async (
  deps: SeedSurfaceDeps,
  input: { appId: AppId; props: Record<string, Json> },
  ctx: RunContext,
): Promise<AppDocument> => onAppRow(input.appId, async () => {
  const app = await deps.requireOwned(input.appId, ctx);
  const seed = app.seed;
  if (seed === undefined) {
    throw new VendoError("conflict", `app ${input.appId} was not created from a host component`);
  }
  const declared = baselineFor(deps, seed.component).sampleProps ?? {};
  const props = Object.fromEntries(
    Object.entries(input.props).filter(([name]) => name in declared),
  );
  // An unchanged call site re-couriers the same values on any re-render its host
  // takes for its own reasons. Writing anyway would put a row through the store
  // on every one of them, so the no-op is answered from what is already stored.
  if (JSON.stringify(seed.props ?? {}) === JSON.stringify(props)) return app;
  const next: AppDocument = { ...app, seed: { ...seed, props } };
  await deps.engine.put(APPS_COLLECTION, appRecordInput(next, ctx.principal.subject, false, "seed"));
  return next;
});

export const createSeedSurface = (deps: SeedSurfaceDeps): AppsRuntime["seed"] => ({
  async drift(appId, ctx): Promise<SeedDrift | null> {
    return seedDrift(await deps.requireOwned(appId, ctx), deps.config.seedBaselines ?? []);
  },
  reseed: (input, ctx) => reseed(deps, input, ctx),
  from: (input, ctx) => seedFrom(deps, input, ctx),
  props: (input, ctx) => courierProps(deps, input, ctx),
});
