import {
  isPlainObject,
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
  validateTree,
  type AppDocument,
  type ComponentPaintResult,
  type PendingSurface,
  type TreeQuery,
  type Tree,
  stripServerAuthoritativeFields,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import type { AppCaller } from "./call.js";
import type { InClientVenueState } from "../remix/inclient.js";
import { bundleOf, seedDrift, type SeedBaseline, type SeedDrift } from "../../contract/index.js";
import type { OpenSurface } from "../runtime/runtime.js";

/**
 * v2 spec §2 — a query's result lives at `"/" + name`: always a single
 * top-level key, because both producers of a query name (validateTree and the
 * wire compiler) hold it to `/^[A-Za-z_][A-Za-z0-9_]*$/`, so no separator,
 * escape or index can occur. Own-property define so the one hostile name that
 * grammar DOES admit — `__proto__` — becomes data, never the prototype.
 * Mirrors ui/src/tree/mcp-shim/shim-core.ts.
 */
const setQueryData = (data: Record<string, Json>, query: TreeQuery, output: Json): void => {
  Object.defineProperty(data, query.name, {
    value: structuredClone(output),
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

interface QueryState {
  key: string;
  query: TreeQuery;
  settled: boolean;
  result?: Awaited<ReturnType<AppCaller["callQuery"]>>;
  error?: unknown;
}

export interface ProgressiveQueryResolver {
  update(tree: Tree): void;
  complete(): Promise<Record<string, Json>>;
  /**
   * Whether a settled query contributed no data because it FAILED — threw,
   * answered "error", or was refused by the guard ("blocked", "connect-required",
   * "pending-approval"). The caller turns this into the tree's `dataUnavailable`
   * marker (renderer.tsx).
   *
   * The refusals count deliberately: in every one of them the person's data did
   * not arrive and every binding renders "—". An actionable refusal deserves its
   * own affordance too, but that is renderer work on top of this marker, not
   * instead of it. An "ok" answer with an empty result is NOT a failure: empty is
   * an answer, and claiming otherwise is the same lie in reverse.
   */
  dataUnavailable(): boolean;
}

/**
 * Start queries as soon as they appear. Results may arrive in any order, but
 * every emitted/final data model is rebuilt in source order so later queries
 * retain the same deterministic last-write behavior as the old serial loop.
 */
export const createProgressiveQueryResolver = (
  caller: AppCaller,
  app: AppDocument,
  ctx: RunContext,
  onData?: (data: Record<string, Json>) => void,
): ProgressiveQueryResolver => {
  const states: QueryState[] = [];
  const pending = new Set<Promise<void>>();
  let baseData: Record<string, Json> = {};
  let resolvedData: Record<string, Json> = {};
  /** Recomputed with the data, so a re-run query (update()) clears it. */
  let unavailable = false;

  // A query that does not settle "ok" contributes NO data, so the app renders
  // its empty state ("No spending data") with the tree, the document and the
  // logs all looking perfectly healthy. That silence cost a live triage
  // (2026-07-27): the empty card had to be told apart from a frozen one by
  // reading DOM attributes. Report each distinct non-ok query once — the
  // render behavior is unchanged, it just stops being invisible.
  const reported = new Set<string>();
  const reportUnresolved = (state: QueryState): void => {
    if (state.result?.status === "ok" || reported.has(state.key)) return;
    reported.add(state.key);
    const why = state.error !== undefined
      ? safeErrorMessage(state.error)
      : state.result === undefined
        ? "the call did not settle"
        : `the call answered "${state.result.status}"`;
    log({
      code: "apps.query-resolved-no-data",
      level: "warn",
      message: `[vendo] query "${state.query.name}" (tool "${state.query.tool}") resolved no data for app ${app.id} — ${why}; anything bound to it renders empty`,
    });
  };

  const recompute = (notify = true): void => {
    const data = structuredClone(baseData);
    let failed = false;
    for (const state of states) {
      if (!state.settled) continue;
      if (state.result?.status !== "ok") {
        reportUnresolved(state);
        failed = true;
        continue;
      }
      setQueryData(data, state.query, state.result.output);
    }
    resolvedData = data;
    unavailable = failed;
    if (notify) onData?.(structuredClone(data));
  };

  const start = (query: TreeQuery, index: number): void => {
    const key = JSON.stringify(query);
    const state: QueryState = { key, query: structuredClone(query), settled: false };
    states[index] = state;
    const task = caller
      .callQuery(app, query.tool, query.input ?? {}, ctx)
      .then((result) => {
        if (states[index] !== state) return;
        state.result = result;
        state.settled = true;
        recompute();
      })
      .catch((error: unknown) => {
        if (states[index] !== state) return;
        state.settled = true;
        state.error = error;
        recompute();
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return {
    update(tree) {
      baseData = structuredClone(tree.data ?? {});
      const queries = tree.queries ?? [];
      if (states.length > queries.length) states.length = queries.length;
      queries.forEach((query, index) => {
        const key = JSON.stringify(query);
        if (states[index]?.key !== key) start(query, index);
      });
      recompute(false);
    },
    async complete() {
      while (pending.size > 0) await Promise.all([...pending]);
      recompute(false);
      return structuredClone(resolvedData);
    },
    dataUnavailable() {
      return unavailable;
    },
  };
};

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

/**
 * execution-v2 Wave 4 — the layer-3 served surface seam the runtime injects:
 * `enabled` mirrors the host's experimental flag, and `urlFor` wakes the app's
 * machine (wake-on-open) and resolves its public ingress URL for $PORT.
 */
export interface ServedSurface {
  /** Build contract §9.8 — EVERY served app is answered with this deployment's
      authenticated proxy url, re-checked per request. It takes no ctx because
      there is nothing left to decide per caller: a second answer for a second
      kind of caller is exactly the door that leaked. */
  urlFor(app: AppDocument): Promise<string>;
}

/** The seams an open reads a venue verdict through, passed as one so the two
 *  artifact paths can share them without a five-argument call. */
interface VenueSeams {
  inClient: ((app: AppDocument) => Promise<InClientVenueState | undefined>) | undefined;
  venueState: ((app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>) | undefined;
  seedBaselines: readonly SeedBaseline[];
}

/**
 * The open surface of a COMPONENT screen, once the gauntlet has rendered it.
 *
 * Its own function because it carries the SAME venue states the tree path does —
 * they are facts about the app and its viewer, not about which artifact the app
 * happens to be written in, and a screen that skipped them opened a review-kind
 * remix with no verdict on it at all.
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
  // Written HERE, after the render, so nothing a screen produced can forge one.
  const inClient = await seams.inClient?.(app);
  if (inClient !== undefined) payload.inClient = inClient as unknown as Json;
  for (const [key, value] of Object.entries(await additionalVenueState(seams.venueState, app, ctx))) {
    if (key === "inClient" || key === "data" || key === "seedDrift" || key === "dataUnavailable") continue;
    payload[key] = value as Json;
  }
  const drift = seedDrift(app, seams.seedBaselines);
  if (drift !== null) payload.seedDrift = drift as unknown as Json;
  // The review-kind gate, for the same reason and with the same teeth as the
  // tree path's: an unapproved review-kind version ships NO executable source.
  // A screen's `interactive` half IS that source — the compiled module plus the
  // query answers it rendered on — so it is what must not leave here. The client
  // keeps the ORIGINAL host component and surfaces the standing `inClient`.
  if (inClient?.granted === false && inClient.reason === "pending-review") {
    return { kind: "tree", payload: payload as unknown as UIPayload };
  }
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
  caller: AppCaller,
  seedBaselines: readonly SeedBaseline[] = [],
  inClientVenue: ((app: AppDocument) => Promise<InClientVenueState | undefined>) | undefined,
  served: ServedSurface,
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
   * to `can(editor)`). Its keys spread onto the payload beside `inClient`; the
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
  if (app.ui === "http") {
    // A served document without a machine has NO surface anywhere (a v1-era
    // import or a de-graduated doc): say so instead of a confusing wake error.
    if (app.machine === undefined) {
      throw new VendoError(
        "validation",
        "this served app has no machine — its surface is gone; re-graduate it with an edit or re-create the app",
      );
    }
    // No wake on open: the URL is this deployment's proxy, and the proxy wakes
    // the machine on the first forwarded request — after it has re-checked
    // access. The host shows its ordinary loading state for that wake latency
    // (no v1 cover or screenshot machinery); the embed's keepalive ping is what
    // notices a machine that went back to sleep.
    return { kind: "http", url: await served.urlFor(app) };
  }

  // A COMPONENT screen (`app.tsx`) has no stored tree, and never will: a screen's
  // tree is what RENDERING it produces, so the screen is re-run HERE, on every
  // open — its queries resolve against the world as it is this instant and the
  // payload carries today's numbers. `authoredScreen` deliberately stores no
  // snapshot, so there is nothing stale to be tempted by.
  //
  // Read BEFORE `app.tree`, the same way the row-scoped `validate` reads a stored
  // app (`componentScreenOf`, doors/build-surface.ts): when a document carries
  // both, the screen IS the app and the tree is an older picture of it. Inline
  // text only, for that door's reason too — a spilled screen's bytes are a blob
  // fetch, which would be a second way to read an app.
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
      inClient: inClientVenue,
      venueState,
      seedBaselines,
    });
  }

  if (app.tree === undefined) {
    // A remix's row lands the instant ✦ fires; its screen is what the first edit
    // GENERATES, tens of seconds later. "Not ready yet" is not "broken", so it
    // answers the same not-found every app gives before its build lands — which
    // the wire's build window (openWithPendingWindow, wire/apps.ts) turns into
    // {kind:"pending"} for a caller who can see the app. A validation failure
    // here is what left the ✦ pill on "Remixing…" until a page reload.
    if (app.seed !== undefined) {
      throw new VendoError("not-found", `app ${app.id} has no screen yet`);
    }
    throw new VendoError("validation", "tree app has no ui payload");
  }
  // v2 spec §§1–2 — the canonical vendo-genui/v2 tree: validate, resolve
  // queries (results at "/" + name), and serve with document components at
  // payload level (the renderer lifts them into the shared walk).
  if (app.tree.formatVersion === VENDO_TREE_FORMAT) {
    const validation = validateTree(app.tree);
    if (!validation.ok) throw new VendoError("validation", validation.error.message);
    const tree = stripServerAuthoritativeFields(structuredClone(validation.tree));
    const inClient = await inClientVenue?.(app);
    if (inClient !== undefined) {
      (tree as Tree & { inClient: InClientVenueState }).inClient = inClient;
    }
    // §9.9 — additive, and deliberately AFTER inClient: an additive state may
    // add keys, never overwrite the trust-axis verdict the client renders from.
    //
    // Guarded like the runtime's `onDocumentEdit` hook, and for the same reason:
    // this state is an ENRICHMENT of the app, resolved through host-composed
    // seams that touch the store. A hiccup in the adoption lookup must cost the
    // caller the card, never the app — an app that will not open is a far worse
    // failure than one that opens without an ask on it.
    for (const [key, value] of Object.entries(await additionalVenueState(venueState, app, ctx))) {
      // `dataUnavailable` is reserved for the same reason as the other three: it is
      // a claim about queries THIS open ran, which a venue hook has not.
      if (key === "inClient" || key === "data" || key === "seedDrift" || key === "dataUnavailable") continue;
      (tree as Tree & Record<string, unknown>)[key] = value;
    }
    const drift = seedDrift(app, seedBaselines);
    if (drift !== null) {
      (tree as Tree & { seedDrift: SeedDrift }).seedDrift = drift;
    }
    // Review-kind gate (2026-08-02): an unapproved review-kind version ships
    // NO executable source — no components, no componentTools, no furnishings,
    // no resolved query data — so a jailed fork render cannot occur even on a
    // client that ignores the venue state. The client keeps the ORIGINAL host
    // component in place and surfaces the standing riding `inClient`.
    if (inClient?.granted === false && inClient.reason === "pending-review") {
      return { kind: "tree", payload: tree as unknown as UIPayload };
    }
    attachSeedFurnishings(tree, app);
    const queries = createProgressiveQueryResolver(caller, app, ctx);
    queries.update(tree);
    tree.data = await queries.complete();
    // A query that failed contributes no data, so every binding under it renders
    // "—" and reads as "you have no spending". Written here, after the strip above,
    // so no document can forge it.
    if (queries.dataUnavailable()) {
      (tree as Tree & { dataUnavailable: true }).dataUnavailable = true;
    }
    const payload = {
      ...tree,
      ...(app.components === undefined ? {} : { components: componentSources(app.components) }),
      // W4b — the stamped per-island tool manifests ride the payload beside
      // the sources; the renderer exposes ONLY these tools to each island.
      ...(app.componentTools === undefined ? {} : { componentTools: structuredClone(app.componentTools) }),
    } as unknown as UIPayload;
    return app.components === undefined
      ? { kind: "tree", payload }
      : { kind: "tree", payload, components: componentSources(app.components) };
  }
  // 01-core §8 — an unregistered format tag is a contained failure: the payload
  // passes through untouched (no query resolution) and the renderer shows the
  // notice. v2 is the only registered tree format (v1 is discarded).
  const payload = stripServerAuthoritativeFields(structuredClone(app.tree));
  return app.components === undefined
    ? { kind: "tree", payload }
    : { kind: "tree", payload, components: componentSources(app.components) };
};

/**
 * The GEOMETRY a half-built app may show, read STRAIGHT OFF THE STORED DOCUMENT:
 * node ids, component names, nesting, and the `streaming` tag that holds the
 * renderer on the forming silhouette instead of a verdict (renderer.tsx).
 *
 * READ, never rendered — that is the whole point of this function's shape. It
 * used to reduce a freshly SERVED payload, which meant every 1.2s pending poll
 * ran the full open path on a mid-build document and threw the result away:
 * ~250 renders across a five-minute build window, each one a compile, a VM boot
 * and a real query fan-out through the guard, as the user, against the host's own
 * backend (measured ~90ms and one query execution per poll on a one-query
 * screen). Nothing here executes the app any more: a poll is a document read.
 *
 * Everything a figure could ride is dropped, because a draft's figures are the
 * ones the build is about to correct. `props` goes because it is where both
 * artifacts keep their numbers — a v2 tree's as `$path` bindings, a painted
 * screen's as literals; `data` because it is the resolved query results those
 * bindings point at; `interactive` and `components` because they are executable
 * halves that would re-render the draft live in the browser. What is left cannot
 * express a number — a whitelist, never a redaction.
 *
 * Two ids do travel: `root` and each node's own. They are never rendered as text,
 * and keeping them is what lets the silhouette MORPH into the finished app
 * instead of remounting it, so they stay — noting that an author who wrote
 * `key={tx.amount}` would put a figure inside an id it never displays.
 *
 * Shape-checked rather than cast, and it cannot throw: a document whose stored
 * tree is missing, differently tagged, or malformed simply yields no geometry,
 * which is the contract's ordinary "not paintable yet" and the embed's beat bar.
 * There is no swallowed error here to report to an operator, so — unlike the
 * seams above that log — there is nothing for this one to say.
 */
const formingTreeOf = (app: AppDocument): UIPayload | undefined => {
  const tree = app.tree;
  if (tree === undefined || tree.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  if (typeof tree.root !== "string" || !Array.isArray(tree.nodes)) return undefined;
  const nodes = tree.nodes.flatMap((node) => {
    if (!isPlainObject(node) || typeof node["id"] !== "string" || typeof node["component"] !== "string") return [];
    const children = node["children"];
    return [{
      id: node["id"],
      component: node["component"],
      ...(Array.isArray(children) ? { children: structuredClone(children) as Json } : {}),
    }];
  });
  return nodes.length === 0
    ? undefined
    : { formatVersion: VENDO_TREE_FORMAT, root: tree.root, nodes, streaming: true };
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
 * `pending` asks for that window's ADDITIVE half instead: the same refusal to
 * serve, plus whatever geometry the stored document ALREADY holds, so the embed's
 * 1.2s poll can paint stepped assembly. It is the caller opting into an answer it
 * must not mount — never a second way to open an app — so it is a flag on this
 * door rather than a kind `open()` can return on its own. Nothing about it opens
 * the app: `formingTreeOf` reads the row, so a poll costs a document read and the
 * build window carries no render load at all.
 *
 * A COMPONENT SCREEN therefore rides no geometry, and reads its beat bar instead:
 * `screenDocument` (write-surface.ts) stores no tree for one, because a screen's
 * tree is what RENDERING it produces. Its silhouette exists only inside a paint,
 * and paying for a paint per poll is the load this function exists to avoid.
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
    const tree = formingTreeOf(app);
    return tree === undefined ? { kind: "pending" } : { kind: "pending", tree };
  };
};
