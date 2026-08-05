import {
  VENDO_TREE_FORMAT,
  VendoError,
  safeErrorMessage,
  validateTree,
  type AppDocument,
  type Json,
  type RunContext,
  type TreeQuery,
  type Tree,
  type UIPayload,
} from "@vendoai/core";
import type { AppCaller } from "./call.js";
import type { InClientVenueState } from "./inclient.js";
import { detectPinDrift, pinComponentName, type PinBaseline, type PinDrift } from "./pins.js";
import type { OpenSurface } from "./runtime.js";

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Query paths come from the app document — model-written or imported from an untrusted
// .vendoapp artifact — so a pointer segment that names a prototype key must never resolve.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const decodePointer = (pointer: string): string[] | null => {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const encoded = pointer.slice(1).split("/");
  if (encoded.some((part) => /~(?![01])/u.test(part))) return null;
  const parts = encoded.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((part) => UNSAFE_KEYS.has(part))) return null;
  return parts;
};

type JsonContainer = Record<string, Json> | Json[];
const arrayIndex = (part: string): number | null => /^(0|[1-9][0-9]*)$/.test(part) ? Number(part) : null;

const child = (target: JsonContainer, part: string): Json | undefined => {
  if (Array.isArray(target)) {
    const index = arrayIndex(part);
    return index === null ? undefined : target[index];
  }
  return target[part];
};

const assignChild = (target: JsonContainer, part: string, value: Json): boolean => {
  if (Array.isArray(target)) {
    const index = arrayIndex(part);
    if (index === null || !Number.isSafeInteger(index) || index > target.length) return false;
    target[index] = value;
    return true;
  }
  target[part] = value;
  return true;
};

const setQueryData = (data: Record<string, Json>, pointer: string, value: Json): boolean => {
  const parts = decodePointer(pointer);
  if (parts === null) return false;
  if (parts.length === 0) {
    if (!isObject(value)) return false;
    const replacement = structuredClone(value);
    for (const key of Object.keys(data)) delete data[key];
    for (const [key, item] of Object.entries(replacement)) {
      if (!UNSAFE_KEYS.has(key)) data[key] = item;
    }
    return true;
  }
  let target: JsonContainer = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (part === undefined || next === undefined) return false;
    let current = child(target, part);
    if (!isObject(current) && !Array.isArray(current)) {
      current = arrayIndex(next) === null ? {} : [];
      if (!assignChild(target, part, current)) return false;
    }
    target = current as JsonContainer;
  }
  const final = parts.at(-1);
  if (final === undefined) return false;
  return assignChild(target, final, structuredClone(value));
};

/** A v2 query's result lives at `"/" + name` by definition (v2 spec §2). */
const queryPointer = (query: TreeQuery): string => `/${query.name}`;

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
    console.warn(`[vendo] query "${state.query.name}" (tool "${state.query.tool}") resolved no data for app ${app.id} — ${why}; anything bound to it renders empty`);
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
      setQueryData(data, queryPointer(state.query), state.result.output);
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
 * 06-apps §§8–9 — the in-client venue field and the pin-drift report are
 * SERVER-AUTHORITATIVE. The stored tree is model-written or imported from an
 * untrusted `.vendoapp`, so a forged `inClient` or `pinDrift` riding the
 * document must never reach the client: strip both before the verified
 * verdict and the computed drift (when any) are attached — and strip at
 * persist time too (the runtime shares this helper), streamed or at rest.
 *
 * `dataUnavailable` joins them: only the code that ran the queries and watched
 * them fail may tell the user their data did not load. Document-carried it would
 * be a claim about a load that never happened, and a transient failure must never
 * be persisted as one.
 */
export const stripServerAuthoritativeFields = <T extends object>(payload: T): T => {
  delete (payload as { inClient?: unknown }).inClient;
  delete (payload as { pinDrift?: unknown }).pinDrift;
  delete (payload as { dataUnavailable?: unknown }).dataUnavailable;
  stripFurnishingPackages(payload);
  return payload;
};

/**
 * CDN package loading is a PREVIEW-VENUE capability, and this is the wall that
 * keeps it there. `attachPinFurnishings` below copies a fixed field list that
 * has never included `packages`, so the runtime cannot produce one; this strip
 * covers the other direction — a model-written or imported `.vendoapp` tree
 * CLAIMING it. Without it, a stored document could make a customer's own page
 * fetch scripts from a third party on their end users' behalf.
 */
const stripFurnishingPackages = (payload: object): void => {
  const { furnishings } = payload as { furnishings?: unknown };
  if (typeof furnishings !== "object" || furnishings === null) return;
  for (const furnishing of Object.values(furnishings as Record<string, unknown>)) {
    if (typeof furnishing === "object" && furnishing !== null) {
      delete (furnishing as { packages?: unknown }).packages;
    }
  }
};

/** 06-apps §8 — jail furnishing for forked pins rides inside the tagged tree
 *  payload (UIPayload is forward-compatible). */
const attachPinFurnishings = (
  tree: Tree,
  app: AppDocument,
  pinBaselines: readonly PinBaseline[],
): void => {
  const furnishings = Object.fromEntries((app.pins ?? []).flatMap((pin) => {
    const baseline = pinBaselines.find((candidate) => candidate.slot === pin.slot && candidate.hash === pin.base);
    if (baseline === undefined) return [];
    return [[pinComponentName(pin.slot), {
      ...(baseline.sourceImports === undefined ? {} : { sourceImports: structuredClone(baseline.sourceImports) }),
      ...(baseline.subSources === undefined ? {} : { subSources: structuredClone(baseline.subSources) }),
      ...(baseline.sampleProps === undefined ? {} : { sampleProps: structuredClone(baseline.sampleProps) }),
      ...(baseline.styles === undefined ? {} : { styles: structuredClone(baseline.styles) }),
    }]];
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

/** Wave 9 — the one refusal for NEW layer-2 box work while machines are off.
 *  The escalation ladder only lands here when no automation can express the
 *  request, so the message says exactly that instead of silently degrading to a
 *  broken automation. Already-provisioned machines are never gated by this —
 *  only new graduation/provisioning is. */
export const machinesDisabledError = (): VendoError => new VendoError(
  "not-implemented",
  "this request needs custom server code (a box machine), and machine-backed (layer-2) execution is experimental and disabled for this project — enable it with createVendo({ apps: { experimentalMachines: true } }) (AppsConfig.experimentalMachines); scheduled/triggered work that tools can express rides the automations engine without it",
  { experiment: "machines", flag: "experimentalMachines" },
);

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
    console.warn(`[vendo] venue state for app ${app.id} could not be resolved: ${safeErrorMessage(error)}; the app opens without it`);
    return {};
  }
};

/** 06-apps §§1–2 — construct the open surface. */
export const createAppOpener = (
  caller: AppCaller,
  pinBaselines: readonly PinBaseline[] = [],
  inClientVenue: ((app: AppDocument) => Promise<InClientVenueState | undefined>) | undefined,
  served: ServedSurface,
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

  if (app.tree === undefined) {
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
      if (key === "inClient" || key === "data" || key === "pinDrift" || key === "dataUnavailable") continue;
      (tree as Tree & Record<string, unknown>)[key] = value;
    }
    const pinDrift = detectPinDrift(app, pinBaselines);
    if (pinDrift.length > 0) {
      (tree as Tree & { pinDrift: PinDrift[] }).pinDrift = pinDrift;
    }
    // Review-kind gate (2026-08-02): an unapproved review-kind version ships
    // NO executable source — no components, no componentTools, no furnishings,
    // no resolved query data — so a jailed fork render cannot occur even on a
    // client that ignores the venue state. The client keeps the ORIGINAL host
    // component in place and surfaces the standing riding `inClient`.
    if (inClient?.granted === false && inClient.reason === "pending-review") {
      return { kind: "tree", payload: tree as unknown as UIPayload };
    }
    attachPinFurnishings(tree, app, pinBaselines);
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
      ...(app.components === undefined ? {} : { components: structuredClone(app.components) }),
      // W4b — the stamped per-island tool manifests ride the payload beside
      // the sources; the renderer exposes ONLY these tools to each island.
      ...(app.componentTools === undefined ? {} : { componentTools: structuredClone(app.componentTools) }),
    } as unknown as UIPayload;
    return app.components === undefined
      ? { kind: "tree", payload }
      : { kind: "tree", payload, components: structuredClone(app.components) };
  }
  // 01-core §8 — an unregistered format tag is a contained failure: the payload
  // passes through untouched (no query resolution) and the renderer shows the
  // notice. v2 is the only registered tree format (v1 is discarded).
  const payload = stripServerAuthoritativeFields(structuredClone(app.tree));
  return app.components === undefined
    ? { kind: "tree", payload }
    : { kind: "tree", payload, components: structuredClone(app.components) };
};
