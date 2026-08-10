/**
 * `AppsRuntime.seed` — remix provenance as an ordinary app.
 *
 * A remix is not a subsystem. It is a `create` that starts from something that
 * already existed, so this module is thin on purpose: it finds the captured
 * baseline, hands the standard create door a `seed`, and otherwise gets out of
 * the way. Standard validation, standard edit path, standard history.
 *
 * WHAT IS DELIBERATELY NOT HERE (d6): edit replay. A re-seed used to re-fork the
 * new baseline and replay the user's recorded instructions on top, behind a
 * fail-closed preflight over the version trail. That machinery is gone. A
 * re-seed now swaps in the pristine new component and mints a version — which
 * REPLACES whatever the user had made. Drift is a warning and re-seeding is
 * always their choice, so the surface that offers it has to say what it costs.
 */
import {
  VENDO_TREE_FORMAT,
  VendoError,
  seedComponentName,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  hasDefaultExport,
  seedDrift,
  validateAppDocument,
  type AppDocument,
  type SeedBaseline,
  type SeedDrift,
} from "../../contract/index.js";
import { applySeedFork, seededBundle } from "../generation/engine.js";
import { appRecordInput } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, SeedFromInput, VersionEntry } from "../runtime/types.js";

export type SeedSurfaceDeps = Pick<
  AppsRuntimeContext,
  | "config"
  | "apps"
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

/** Apply the deterministic seed to a working copy, surfacing the engine's own
 *  issues as the gesture's error. */
const seedOnto = (base: AppDocument, baseline: SeedBaseline): AppDocument => {
  const seeded = structuredClone(base);
  const issues = applySeedFork(seeded, { slot: baseline.slot }, [baseline])
    .map((issue) => issue.replace(/^seed failed: /, ""));
  if (issues.length > 0) throw new VendoError("conflict", issues.join("; "));
  const validation = validateAppDocument(seeded);
  if (!validation.ok) throw new VendoError("validation", validation.error.message);
  return seeded;
};

/**
 * The ✦ gesture: capture → bundle → create. Deterministic — the captured
 * baseline is copied by the engine with no model call, so the person gets a
 * faithful copy first and any instruction lands on it as an ordinary edit.
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
  // app already carried it, and replaying it would apply the same edit twice.
  if (existing !== undefined) return existing;
  const minted: AppDocument = {
    format: "vendo/app@1",
    id: `app_${globalThis.crypto.randomUUID()}`,
    name: `${baseline.slot} remix`,
    ui: "tree",
    tree: {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Stack", source: "prewired" }],
    },
  };
  // Seed BEFORE persisting, so a baseline the jail could never render never
  // strands an empty app.
  const seeded = seedOnto(minted, baseline);
  if (input.slot !== undefined) seeded.seed = { ...seeded.seed!, slot: input.slot };
  await deps.apps.put(appRecordInput(seeded, ctx.principal.subject, false, "seed"));
  // The version that says where this app came from. `seed.from` is the one
  // create that does not go through `persistEdit`, so it is the one create that
  // has to append its own — without it a remix arrives with no history at all,
  // and a review-kind remix fails closed to pending the moment its current
  // version stops being approved (`serveDocFor`, remix/review.ts).
  await deps.history.append(seeded.id, seeded, {
    at: new Date().toISOString(),
    intent: `Remix the host component "${baseline.slot}"`,
    rung: deps.rungFor(seeded),
  });
  if (input.slot !== undefined) {
    // "Show the remix in THIS slot" is a placement ROW. The seed on the
    // document is provenance, never location.
    await deps.placementRows.put(ctx.principal.subject, {
      slot: input.slot,
      appId: seeded.id,
      placedBy: ctx.principal.subject,
      placedAt: new Date().toISOString(),
    });
  }
  await deps.reportLifecycle("create", seeded.id, ctx);
  // The pre-mint check is list-then-put, so two concurrent gestures can both
  // find nothing and both mint. Close the race after the write: if an OLDER app
  // also carries this seed, the just-minted row deletes itself and the older one
  // wins. List order is deterministic, so both racers pick the same winner and
  // only the loser deletes.
  const oldest = (await deps.runtime().list(ctx)).filter(seededAlready).at(-1);
  if (oldest !== undefined && oldest.id !== seeded.id) {
    await deps.runtime().delete(seeded.id, ctx);
    return oldest;
  }
  // Re-read the stored row: the concurrency check compares against the store's
  // own JSON round-trip, never the in-memory original.
  const stored = await deps.requireOwned(seeded.id, ctx);
  const instruction = input.instruction?.trim();
  if (instruction === undefined || instruction.length === 0) return stored;
  try {
    return (await deps.runtime().edit(stored.id, instruction, ctx)).app;
  } catch {
    // A failed instruction never rolls the seed back — the person keeps the
    // faithful copy.
    return stored;
  }
};

/**
 * d6 — the plain re-seed: swap in the pristine new baseline bundle and mint a
 * version, through the same admission door as any other write.
 *
 * This REPLACES the seeded component, including anything the person changed
 * about it. That is the trade the drift warning has to state out loud.
 */
const reseed = async (
  deps: SeedSurfaceDeps,
  input: { appId: AppId },
  ctx: RunContext,
): Promise<AppDocument> => {
  const app = await deps.requireOwned(input.appId, ctx);
  if (app.seed === undefined) {
    throw new VendoError("conflict", `app ${input.appId} was not created from a host component`);
  }
  const baseline = baselineFor(deps, app.seed.component);
  if (baseline.hash === app.seed.baseline) {
    throw new VendoError("conflict", `${app.seed.component} has not changed since this app was created`);
  }
  // Swap the SEAT's contents, in place. The node, its props and the rest of the
  // tree are the person's app and are not this gesture's to rearrange — only
  // what sits in the seeded seat changes, which is exactly what "the pristine
  // new component" means.
  const componentName = seedComponentName(app.seed.component);
  const bundle = seededBundle(baseline);
  if (!hasDefaultExport(bundle.source)) {
    throw new VendoError(
      "conflict",
      `${app.seed.component} has no default export and no component export to alias; export it from its module and re-run vendo sync`,
    );
  }
  const reseeded = structuredClone(app);
  reseeded.components = { ...(reseeded.components ?? {}), [componentName]: bundle };
  reseeded.seed = {
    component: app.seed.component,
    baseline: baseline.hash,
    ...(app.seed.slot === undefined ? {} : { slot: app.seed.slot }),
    ...(baseline.review === undefined ? {} : { review: baseline.review }),
  };
  const validation = validateAppDocument(reseeded);
  if (!validation.ok) throw new VendoError("validation", validation.error.message);
  const version: VersionEntry = {
    at: new Date().toISOString(),
    intent: `Update ${app.seed.component} to the host's current version`,
    rung: deps.rungFor(reseeded),
  };
  const persisted = await deps.persistEdit(app, reseeded, version, ctx.principal.subject, { origin: "seed" });
  await deps.reportLifecycle("reseed", app.id, ctx, {
    component: app.seed.component,
    fromBaseline: app.seed.baseline,
    toBaseline: baseline.hash,
  });
  return persisted;
};

export const createSeedSurface = (deps: SeedSurfaceDeps): AppsRuntime["seed"] => ({
  async drift(appId, ctx): Promise<SeedDrift | null> {
    return seedDrift(await deps.requireOwned(appId, ctx), deps.config.seedBaselines ?? []);
  },
  reseed: (input, ctx) => reseed(deps, input, ctx),
  from: (input, ctx) => seedFrom(deps, input, ctx),
});
