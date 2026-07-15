import {
  VENDO_TREE_FORMAT,
  VendoError,
  validateTree,
  type AppDocument,
  type Json,
  type RunContext,
  type StoreAdapter,
  type Tree,
  type TreeQuery,
  type UIPayload,
} from "@vendoai/core";
import type { AppCaller } from "./call.js";
import type { MachineSessions } from "./machine.js";
import { pinComponentName, type PinBaseline } from "./pins.js";
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

const bytesToDataUri = (bytes: Uint8Array, contentType = "image/png"): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${contentType};base64,${globalThis.btoa(binary)}`;
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
}

/**
 * Start queries as soon as they appear. Results may arrive in any order, but
 * every emitted/final data model is rebuilt in source order so later queries
 * retain the same deterministic last-write behavior as the old serial loop.
 */
export const createProgressiveQueryResolver = (
  machines: MachineSessions,
  caller: AppCaller,
  app: AppDocument,
  ctx: RunContext,
  onData?: (data: Record<string, Json>) => void,
  authorization?: Awaited<ReturnType<MachineSessions["mintRun"]>>,
): ProgressiveQueryResolver => {
  const authorizationPromise = authorization === undefined
    ? machines.mintRun(app, ctx)
    : Promise.resolve(authorization);
  const states: QueryState[] = [];
  const pending = new Set<Promise<void>>();
  let baseData: Record<string, Json> = {};
  let resolvedData: Record<string, Json> = {};

  const recompute = (notify = true): void => {
    const data = structuredClone(baseData);
    for (const state of states) {
      if (!state.settled || state.result === undefined) continue;
      const { outcome, uiEnvelope } = state.result;
      if (outcome.status !== "ok" || uiEnvelope) continue;
      setQueryData(data, state.query.path, outcome.output);
    }
    resolvedData = data;
    if (notify) onData?.(structuredClone(data));
  };

  const start = (query: NonNullable<Tree["queries"]>[number], index: number): void => {
    const key = JSON.stringify(query);
    const state: QueryState = { key, query: structuredClone(query), settled: false };
    states[index] = state;
    const task = authorizationPromise
      .then((run) => caller.callQuery(app, query.tool, query.input ?? {}, ctx, run))
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
      const fatal = states.find((state) =>
        state.error instanceof VendoError && state.error.code === "sandbox-unavailable")?.error;
      if (fatal !== undefined) throw fatal;
      recompute(false);
      return structuredClone(resolvedData);
    },
  };
};

/** 06-apps §§1–2 — construct the invisible-graduation open surface. */
export const createAppOpener = (
  machines: MachineSessions,
  caller: AppCaller,
  store: StoreAdapter,
  pinBaselines: readonly PinBaseline[] = [],
): ((app: AppDocument, ctx: RunContext) => Promise<OpenSurface>) => async (app, ctx) => {
  const authorization = await machines.mintRun(app, ctx);
  if (app.ui === "http") {
    if (!machines.available()) throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    const machine = machines.peek(app.id);
    if (machine !== undefined) {
      if (machine.url === undefined) {
        throw new VendoError("sandbox-unavailable", "adapter cannot serve http apps");
      }
      try {
        return { kind: "http", url: await machine.url(8080) };
      } catch {
        throw new VendoError("sandbox-unavailable", "adapter cannot serve http apps");
      }
    }
    machines.wake(app, ctx, authorization);
    const cover = await store.blobs(`app:${app.id}`).get("cover.png");
    return cover === null
      ? { kind: "resuming" }
      : { kind: "resuming", cover: bytesToDataUri(cover.bytes, cover.contentType) };
  }

  if (app.tree === undefined) {
    throw new VendoError("validation", "tree app has no ui payload");
  }
  // 01-core §8 — an unregistered format tag is a contained failure: the payload passes
  // through untouched (no query resolution) and the renderer shows the notice.
  if (app.tree.formatVersion !== VENDO_TREE_FORMAT) {
    return app.components === undefined
      ? { kind: "tree", payload: structuredClone(app.tree) }
      : { kind: "tree", payload: structuredClone(app.tree), components: structuredClone(app.components) };
  }
  const validation = validateTree({ ...app.tree, components: app.components });
  if (!validation.ok) throw new VendoError("validation", validation.error.message);
  // Keep components INSIDE the wire payload: Tree.components is the wire-level
  // field (01 §8, "lifted to the app document at rest") and the renderer compiles
  // generated components from payload.components. The OpenSurface sibling stays
  // for 06 §1 shape fidelity.
  const tree: Tree = structuredClone(validation.tree);
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
  // UIPayload is explicitly forward-compatible. Furnishing rides inside the
  // tagged tree payload so the frozen OpenSurface sibling shape stays intact.
  if (Object.keys(furnishings).length > 0) {
    (tree as Tree & { furnishings: typeof furnishings }).furnishings = furnishings;
  }
  const queries = createProgressiveQueryResolver(machines, caller, app, ctx, undefined, authorization);
  queries.update(tree);
  tree.data = await queries.complete();
  return app.components === undefined
    ? { kind: "tree", payload: tree as unknown as UIPayload }
    : {
      kind: "tree",
      payload: tree as unknown as UIPayload,
      components: structuredClone(app.components),
    };
};
