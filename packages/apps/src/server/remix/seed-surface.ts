/**
 * `AppsRuntime.seed` — remix provenance as an ordinary app.
 *
 * A remix is not a subsystem. It is a `create` that starts from something that
 * already existed, so this module is thin on purpose: it finds the captured
 * baseline, records what the person asked for, and hands the ordinary edit door
 * the instruction. Standard validation, standard edit path, standard history.
 *
 * WHAT IS DELIBERATELY NOT HERE: a bare fork. Nothing copies the captured source
 * into the minted app and nothing evaluates one — the ✦ gesture collects an
 * INSTRUCTION first, and fork plus first edit are ONE operation whose output is a
 * REGULAR SCREEN (`app.tsx`, through the ordinary edit door). The captured
 * baseline is provenance: what the remix started from, and what a re-seed
 * replays the recorded wishes against.
 */
import {
  VendoError,
  safeErrorMessage,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  seedDrift,
  type AppDocument,
  type SeedBaseline,
  type SeedDrift,
} from "../../contract/index.js";
import { APPS_COLLECTION, appRecordInput } from "../persistence/persistence.js";
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
>;

const baselineFor = (deps: SeedSurfaceDeps, component: string): SeedBaseline => {
  const baseline = (deps.config.seedBaselines ?? []).find(({ slot }) => slot === component);
  if (baseline === undefined) {
    throw new VendoError(
      "not-found",
      `remixable component "${component}" has no captured baseline; wrap it in <Remixable> and run vendo sync`,
    );
  }
  return baseline;
};

/**
 * The ✦ gesture: record the provenance, then run the person's instruction
 * through the ordinary edit door. What comes back is an ordinary screen app that
 * happens to know where it came from.
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
  // No screen yet, so this app does not open: the host's live original stays on
  // the page until the edit below lands one.
  await deps.engine.put(APPS_COLLECTION, appRecordInput(minted, ctx.principal.subject, false, "seed"));
  // The version that says where this app came from. `seed.from` is the one
  // create that does not go through `persistEdit`, so it is the one create that
  // has to append its own — without it a remix arrives with no history at all,
  // and a review-kind remix fails closed to pending the moment its current
  // version stops being approved (`serveDocFor`, remix/review.ts).
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
  // A failed instruction never hands the caller an error over an app that
  // already exists — it leaves the terminal marker every other failed build
  // leaves. `open()` then answers `failed` instead of pending forever, and
  // `list()` skips the row, so the next ✦ tap mints a fresh app instead of
  // deduping onto this screenless one. `edit()` THROWS only when no model is
  // wired and RETURNS its common failure, hence both arms.
  let reason: string;
  try {
    const edited = await deps.runtime().edit(stored.id, input.instruction, ctx);
    if (edited.failure === undefined) return edited.app;
    reason = (edited.issues ?? []).join("; ") || edited.failure.message;
  } catch (error) {
    reason = safeErrorMessage(error);
  }
  const failed: AppDocument = {
    ...stored,
    buildFailed: { reason, retryable: true, at: new Date().toISOString(), prompt: input.instruction },
  };
  await deps.engine.put(APPS_COLLECTION, appRecordInput(failed, ctx.principal.subject, false, "seed"));
  return failed;
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
  // The replay goes FIRST and the provenance moves only once something has
  // landed: `edit()` reports the common failure in `failure` rather than
  // throwing, so rebasing ahead of it left the OLD screen claiming the host's
  // current version — no drift warning, and every retry refused as a conflict
  // above.
  const unapplied: string[] = [];
  let replayed = app;
  for (const wish of seed.wishes) {
    const edited = await deps.runtime().edit(app.id, wish, ctx);
    if (edited.failure === undefined) replayed = edited.app;
    else unapplied.push(wish);
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

export const createSeedSurface = (deps: SeedSurfaceDeps): AppsRuntime["seed"] => ({
  async drift(appId, ctx): Promise<SeedDrift | null> {
    return seedDrift(await deps.requireOwned(appId, ctx), deps.config.seedBaselines ?? []);
  },
  reseed: (input, ctx) => reseed(deps, input, ctx),
  from: (input, ctx) => seedFrom(deps, input, ctx),
});
