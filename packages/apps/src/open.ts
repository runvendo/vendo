import {
  VENDO_TREE_FORMAT_V2,
  VendoError,
  validateTreeV2,
  type AppDocument,
  type Json,
  type RunContext,
  type TreeQueryV2,
  type TreeV2,
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
const queryPointer = (query: TreeQueryV2): string => `/${query.name}`;

interface QueryState {
  key: string;
  query: TreeQueryV2;
  settled: boolean;
  result?: Awaited<ReturnType<AppCaller["callQuery"]>>;
  error?: unknown;
}

export interface ProgressiveQueryResolver {
  update(tree: TreeV2): void;
  complete(): Promise<Record<string, Json>>;
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

  const recompute = (notify = true): void => {
    const data = structuredClone(baseData);
    for (const state of states) {
      if (!state.settled || state.result === undefined) continue;
      if (state.result.status !== "ok") continue;
      setQueryData(data, queryPointer(state.query), state.result.output);
    }
    resolvedData = data;
    if (notify) onData?.(structuredClone(data));
  };

  const start = (query: TreeQueryV2, index: number): void => {
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
  };
};

/**
 * 06-apps §§8–9 — the in-client venue field and the pin-drift report are
 * SERVER-AUTHORITATIVE. The stored tree is model-written or imported from an
 * untrusted `.vendoapp`, so a forged `inClient` or `pinDrift` riding the
 * document must never reach the client: strip both before the verified
 * verdict and the computed drift (when any) are attached — and strip at
 * persist time too (the runtime shares this helper), streamed or at rest.
 */
export const stripServerAuthoritativeFields = <T extends object>(payload: T): T => {
  delete (payload as { inClient?: unknown }).inClient;
  delete (payload as { pinDrift?: unknown }).pinDrift;
  return payload;
};

/** 06-apps §8 — jail furnishing for forked pins rides inside the tagged tree
 *  payload (UIPayload is forward-compatible). */
const attachPinFurnishings = (
  tree: TreeV2,
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
    (tree as TreeV2 & { furnishings: typeof furnishings }).furnishings = furnishings;
  }
};

/**
 * execution-v2 Wave 4 — the layer-3 served surface seam the runtime injects:
 * `enabled` mirrors the host's experimental flag, and `urlFor` wakes the app's
 * machine (wake-on-open) and resolves its public ingress URL for $PORT.
 */
export interface ServedSurface {
  enabled: boolean;
  urlFor(app: AppDocument): Promise<string>;
}

/** Wave 4 — the one refusal for every layer-3 path while the flag is off. */
export const servedAppsDisabledError = (): VendoError => new VendoError(
  "not-implemented",
  "served (layer-3) app surfaces are experimental and disabled for this project — enable them with createVendo({ apps: { experimentalServedApps: true } }) (AppsConfig.experimentalServedApps) to let a machine serve the app surface",
  { experiment: "servedApps", flag: "experimentalServedApps" },
);

/** 06-apps §§1–2 — construct the open surface. */
export const createAppOpener = (
  caller: AppCaller,
  pinBaselines: readonly PinBaseline[] = [],
  inClientVenue?: (app: AppDocument) => Promise<InClientVenueState | undefined>,
  served?: ServedSurface,
): ((app: AppDocument, ctx: RunContext) => Promise<OpenSurface>) => async (app, ctx) => {
  if (app.ui === "http") {
    // execution-v2 Wave 4 — the layer-3 served surface, host-gated behind the
    // experimental flag: opening a served app while the flag is off refuses
    // with the SAME typed error as generation (a served app that exists from
    // elsewhere is refused too, not just new builds).
    if (served === undefined || !served.enabled) {
      throw servedAppsDisabledError();
    }
    // A served document without a machine has NO surface anywhere (a v1-era
    // import or a de-graduated doc): say so instead of a confusing wake error.
    if (app.machine === undefined) {
      throw new VendoError(
        "validation",
        "this served app has no machine — its surface is gone; re-graduate it with an edit or re-create the app",
      );
    }
    // Wake-on-open: a sleeping machine resumes here (the accepted wake
    // latency; the host shows its ordinary loading state — no v1 cover or
    // screenshot machinery).
    return { kind: "http", url: await served.urlFor(app) };
  }

  if (app.tree === undefined) {
    throw new VendoError("validation", "tree app has no ui payload");
  }
  // v2 spec §§1–2 — the canonical vendo-genui/v2 tree: validate, resolve
  // queries (results at "/" + name), and serve with document components at
  // payload level (the v2 renderer lifts them into the shared walk).
  if (app.tree.formatVersion === VENDO_TREE_FORMAT_V2) {
    const validation = validateTreeV2(app.tree);
    if (!validation.ok) throw new VendoError("validation", validation.error.message);
    const tree = stripServerAuthoritativeFields(structuredClone(validation.tree));
    const inClient = await inClientVenue?.(app);
    if (inClient !== undefined) {
      (tree as TreeV2 & { inClient: InClientVenueState }).inClient = inClient;
    }
    const pinDrift = detectPinDrift(app, pinBaselines);
    if (pinDrift.length > 0) {
      (tree as TreeV2 & { pinDrift: PinDrift[] }).pinDrift = pinDrift;
    }
    attachPinFurnishings(tree, app, pinBaselines);
    const queries = createProgressiveQueryResolver(caller, app, ctx);
    queries.update(tree);
    tree.data = await queries.complete();
    const payload = {
      ...tree,
      ...(app.components === undefined ? {} : { components: structuredClone(app.components) }),
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
