import {
  log,
  VENDO_TREE_FORMAT,
  VendoError,
  safeErrorMessage,
  type AppId,
  type Json,
  type RunContext,
  type UIPayload,
} from "@vendoai/core";
import {
  buildInFlight,
  componentSources,
  type AppDocument,
  type ComponentPaintResult,
  type PendingSurface,
  type Tree,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { formingTreeOf } from "./forming.js";
import { bundleOf, seedDrift, type SeedBaseline } from "../../contract/index.js";
import type { OpenSurface } from "../runtime/runtime.js";

/**
 * 06-apps §8 — jail furnishing rides inside the tagged tree payload (UIPayload
 * is forward-compatible), read STRAIGHT OFF THE STORED BUNDLE.
 *
 * There is no baseline lookup and no hash match here any more. There used to
 * be, and it is the defect this seam is named after: a seeded app whose host
 * component had moved on matched nothing, so it opened with no imports, no
 * sub-modules and no styles — rendering broken, silently, with no warning that
 * anything was missing. The seat holds its own contents; drift is a separate
 * warning that changes nothing about what opens.
 */
const attachSeedFurnishings = (tree: Tree, app: AppDocument): void => {
  const furnishings = Object.fromEntries(Object.entries(app.components ?? {}).flatMap(([name, entry]) => {
    const bundle = bundleOf(entry);
    if (bundle.origin !== "seeded") return [];
    const furnishing = {
      ...(bundle.sourceImports === undefined ? {} : { sourceImports: structuredClone(bundle.sourceImports) }),
      ...(bundle.subSources === undefined ? {} : { subSources: structuredClone(bundle.subSources) }),
      ...(bundle.sampleProps === undefined ? {} : { sampleProps: structuredClone(bundle.sampleProps) }),
      ...(bundle.styleSheets === undefined ? {} : { styles: structuredClone(bundle.styleSheets) }),
    };
    return Object.keys(furnishing).length === 0 ? [] : [[name, furnishing]];
  }));
  if (Object.keys(furnishings).length > 0) {
    (tree as Tree & { furnishings: typeof furnishings }).furnishings = furnishings;
  }
};

/** The seams an open reads a venue verdict through, passed as one so the two
 *  artifact paths can share them without a five-argument call. */
interface VenueSeams {
  venueState: ((app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>) | undefined;
  seedBaselines: readonly SeedBaseline[];
}

/**
 * The open surface of a COMPONENT screen, once the gauntlet has rendered it.
 *
 * Its own function because it carries the SAME venue states the tree path does —
 * they are facts about the app and its viewer, not about which artifact the app
 * happens to be written in.
 */
const paintedScreenSurface = async (
  app: AppDocument,
  ctx: RunContext,
  painted: Extract<ComponentPaintResult, { ok: true }>,
  seams: VenueSeams,
): Promise<OpenSurface> => {
  // The payload a save paints, field for field (generation/render-seam.ts): the
  // format tag, the flattened nodes, and the interactive half the renderer boots
  // its own live VM from.
  const payload: Record<string, Json> = {
    formatVersion: VENDO_TREE_FORMAT,
    root: painted.root,
    nodes: Object.values(painted.nodes) as unknown as Json,
  };
  for (const [key, value] of Object.entries(await additionalVenueState(seams.venueState, app, ctx))) {
    // `inClient` stays reserved even though nothing authors a verdict anymore:
    // venueState must never be able to smuggle a forged one onto the payload,
    // where a client still carrying the executor could act on it.
    if (key === "inClient" || key === "data" || key === "seedDrift" || key === "seedUnapplied"
      || key === "dataUnavailable") continue;
    payload[key] = value as Json;
  }
  const drift = seedDrift(app, seams.seedBaselines);
  if (drift !== null) payload.seedDrift = drift as unknown as Json;
  // The other half of what the drift notice promises: an update replays every
  // wish AND says which ones the new version could not take. `reseed` records
  // them here and the agent tool speaks them, but the ✦ menu's Update is not a
  // conversation — this payload is the only thing it re-reads, so a report that
  // does not ride it reaches nobody, and a change the person asked for goes
  // missing in silence.
  if (app.seed?.unapplied !== undefined) payload.seedUnapplied = [...app.seed.unapplied];
  payload.interactive = painted.interactive as unknown as Json;
  attachSeedFurnishings(payload as unknown as Tree, app);
  return app.components === undefined
    ? { kind: "tree", payload: payload as unknown as UIPayload }
    : { kind: "tree", payload: payload as unknown as UIPayload, components: componentSources(app.components) };
};

/** The additive venue states for this open, or none when the seam fails.
 *  Reported once per failure so a broken seam is visible to an operator without
 *  costing the person their app. */
const additionalVenueState = async (
  venueState: ((app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>) | undefined,
  app: AppDocument,
  ctx: RunContext,
): Promise<Record<string, unknown>> => {
  try {
    return await venueState?.(app, ctx) ?? {};
  } catch (error) {
    log({
      code: "apps.venue-state-unresolved",
      level: "warn",
      message: `[vendo] venue state for app ${app.id} could not be resolved: ${safeErrorMessage(error)}; the app opens without it`,
    });
    return {};
  }
};

/** 06-apps §§1–2 — the open surface of a document that is DONE building.
 *  `createAppOpener` below is what callers get; this is its servable half. */
const serveOpenApp = (
  seedBaselines: readonly SeedBaseline[] = [],
  /**
   * The COMPONENT screen half of an open: the app's own `app.tsx`, RUN.
   *
   * `AppFloor.component` — the same gauntlet a save paints through — bound by
   * composition to this caller's ctx, because it runs the screen's queries
   * through the guard-bound caller (one guard decision per query, this person's
   * authority, the app venue) and boots the screen on their answers.
   */
  screen: (input: { appId: AppId; source: string }, ctx: RunContext) => Promise<ComponentPaintResult>,
  /**
   * Build contract §9.9 — the ADDITIVE venue-state slot, ctx-aware because the
   * states that ride it are per-caller (lane H's adoption card is served only
   * to `can(editor)`). Its keys spread onto the payload; the
   * server-authoritative strip has already run, so nothing here can be forged
   * by a document. Composable by construction: a second additive state is
   * another key, not another parameter.
   */
  venueState?: (app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>,
): ((app: AppDocument, ctx: RunContext) => Promise<OpenSurface>) => async (app, ctx) => {
  // A terminally failed build never becomes servable: resolve the poll now
  // with the persisted reason (approvals resolve to denied/expired the same
  // way) instead of leaving the embed to spin to its client deadline.
  if (app.buildFailed !== undefined) {
    return {
      kind: "failed",
      reason: app.buildFailed.reason,
      ...(app.buildFailed.retryable === undefined ? {} : { retryable: app.buildFailed.retryable }),
      // The failed prompt rides along so the embed's retry affordance can
      // re-issue the EXACT create (speed-core lane, criterion 8).
      ...(app.buildFailed.prompt === undefined ? {} : { prompt: app.buildFailed.prompt }),
    };
  }
  // FINAL SPEC v1 — a sealed bundle IS the app: the hash is all the surface
  // needs, because the bytes are immutable and the frame fetches them itself
  // (`GET /apps/:id/bundle/:hash`, behind BUNDLE_CSP).
  if (app.ui === "bundle" && app.bundle !== undefined) {
    return { kind: "bundle", entry: app.bundle.entry };
  }
  // A COMPONENT screen (`app.tsx`) is the whole artifact: a screen's tree is what
  // RENDERING it produces, so the screen is re-run HERE, on every open — its
  // queries resolve against the world as it is this instant and the payload
  // carries today's numbers. `authoredScreen` deliberately stores no snapshot,
  // so there is nothing stale to be tempted by.
  //
  // Inline text only, the same way the row-scoped `validate` reads a stored app
  // (`componentScreenOf`, doors/build-surface.ts): a spilled screen's bytes are a
  // blob fetch, which would be a second way to read an app.
  const screenSource = app.source?.[SCREEN_FILE]?.text;
  if (screenSource !== undefined && screenSource.trim() !== "") {
    const painted = await screen({ appId: app.id, source: screenSource }, ctx);
    if (!painted.ok) {
      // The gauntlet's own repair instructions, verbatim: they name the line and
      // what to write instead, and they are the only thing that says why the app
      // the person just had will not open (a host tool that has since changed
      // shape, a query that no longer answers).
      throw new VendoError(
        "validation",
        `this screen did not render: ${painted.blocking.join("; ")}`,
        { appId: app.id },
      );
    }
    // The venue states this payload carries are the tree path's, on identical
    // terms (`paintedScreenSurface`).
    return await paintedScreenSurface(app, ctx, painted, {
      venueState,
      seedBaselines,
    });
  }

  // A remix's row lands the instant ✦ fires; its screen is what the first edit
  // GENERATES, tens of seconds later. "Not ready yet" is not "broken", so it
  // answers the same not-found every app gives before its build lands — which
  // the wire's build window (openApp, wire/apps.ts) turns into
  // {kind:"pending"} for a caller who can see the app. A validation failure
  // here is what left the ✦ pill on "Remixing…" until a page reload.
  if (app.seed !== undefined) {
    throw new VendoError("not-found", `app ${app.id} has no screen yet`);
  }
  // Offered and unanswered. The row exists precisely so the slot can show the
  // standing ask (`proposeRow`, doors/build-door.ts), and "can't be opened any
  // more" is the one thing it must not say to someone who has just been asked
  // whether to build it. Same not-found as the remix above, for the same reason.
  if (app.proposal !== undefined) {
    throw new VendoError("not-found", `app ${app.id} is waiting on its build to be approved`);
  }
  // Nothing left to open. A document with no screen is one written back when a
  // stored tree was the artifact; that field is gone, so there is no layout to
  // serve and never will be. Terminal, and said as such, so the embed resolves
  // with a reason instead of polling to its deadline.
  return {
    kind: "failed",
    reason: "This app can’t be opened any more — create it again to replace it.",
  };
};

/**
 * 06-apps §§1–2 — the one read path a client opens an app through.
 *
 * A build that is still WRITING this app has nothing terminal to serve. Its row
 * lands at the first painting save, tens of seconds before the reviewer pass and
 * its repair round finish, and mounting on the row alone put people in front of a
 * draft — a wrong NUMBER included — that the build then corrected where nobody was
 * looking. So the answer stays the not-found the app gave a moment earlier with no
 * row at all, which the wire's build window turns into the `{kind:"pending"}`
 * every embed already waits on.
 *
 * `pending` names that refusal instead of hiding it behind a not-found, so a
 * caller who may see the app can wait on the build. It is the caller opting into
 * an answer it must not mount — never a second way to open an app — so it is a
 * flag on this door rather than a kind `open()` can return on its own, and it
 * costs a document read: nothing here renders the app.
 *
 * The geometry it rides is the build's OWN paint, read out of memory
 * (`forming.ts`) so that stays true: a poll costs a document read, never a
 * render.
 */
export const createAppOpener = (...args: Parameters<typeof serveOpenApp>): (
  (app: AppDocument, ctx: RunContext, options?: { pending?: boolean }) => Promise<OpenSurface | PendingSurface>
) => {
  const serve = serveOpenApp(...args);
  return async (app, ctx, options) => {
    if (!buildInFlight(app.building)) return await serve(app, ctx);
    if (options?.pending !== true) {
      throw new VendoError("not-found", `app ${app.id} is still being built`, { appId: app.id });
    }
    const tree = formingTreeOf(app.id);
    return {
      kind: "pending",
      ...(app.buildStatus === undefined ? {} : { status: app.buildStatus }),
      ...(tree === undefined ? {} : { tree }),
    };
  };
};
