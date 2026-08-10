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
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  seedDrift,
  validateAppDocument,
  type AppDocument,
  type SeedBaseline,
  type SeedDrift,
} from "../../contract/index.js";
import { applySeedFork } from "../generation/engine.js";
import { appRecordInput } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, SeedFromInput, VersionEntry } from "../runtime/types.js";

export type SeedSurfaceDeps = Pick<
  AppsRuntimeContext,
  | "config"
  | "apps"
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
  // Drop the old seat and seed the new baseline into it: one code path for the
  // first seed and every re-seed after it.
  const stripped = structuredClone(app);
  delete stripped.components?.[app.seed.component];
  delete stripped.seed;
  const reseeded = seedOnto(stripped, baseline);
  reseeded.seed = { ...reseeded.seed!, ...(app.seed.slot === undefined ? {} : { slot: app.seed.slot }) };
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
