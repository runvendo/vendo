/**
 * v4 wave — the smoke-render gate (spec §The fixes: "execute each island
 * headless before ship").
 *
 * Final gate 2026-07-21: the blank-island class is dead, but two crash forms
 * still shipped — C11 (React error #310: useState inside a client .map, the
 * whole app an error blob) and M3-adjacent action-path breakage. Nothing
 * executed island code before ship; this gate does, once, at validation time.
 *
 * Each island's compiled component renders ONCE in a jsdom environment inside
 * a dedicated worker thread, with the ambient scope stubbed:
 *   - real React + real hooks (hooks-order violations must genuinely fire),
 *   - the Kit as minimal pass-through components,
 *   - `fmt` as plain string formatters,
 *   - `tools` as an async stub: read tools resolve a sample instance derived
 *     from the tool's ShapeType (arrays get two items, so data-driven
 *     re-renders exercise hooks the way live data does) or `{}` when no shape
 *     is known; mutating tools resolve {status:"pending-approval"}.
 *
 * SCOPE: this catches CRASHES — throw on render/commit, hooks-order
 * violations, undefined-name references. It deliberately does NOT judge
 * visual wrongness (a zero-bar chart is data-shape territory, out of scope).
 * A render failure is a normal validation issue routed to repair.
 *
 * The worker gives two guarantees an in-process render cannot:
 *   - a hard per-island timeout (worker.terminate preempts infinite loops),
 *   - no globals leaked into the host server process.
 * Environment failures (react/jsdom unresolvable, worker "ready" never
 * arrives) skip the gate silently — the esbuild lazy-load precedent — so a
 * bundler that cannot reach the modules degrades to today's behavior instead
 * of failing creates.
 */
import {
  ISLAND_AMBIENT_KIT_NAMES,
  ISLAND_AMBIENT_REACT_NAMES,
  type ShapeType,
} from "@vendoai/core";
import type { HostToolInfo } from "./engine.js";

export interface SmokeRenderOptions {
  /** name → island TSX source (post-prepare, canonical). */
  components: Record<string, string>;
  /** name → registry tool names the island reaches (the stamped manifest). */
  componentTools: Record<string, string[]>;
  tools?: readonly HostToolInfo[] | undefined;
  toolShapes?: Record<string, ShapeType> | undefined;
  /** Per-island render budget AFTER the worker reports ready (default 1000ms). */
  renderTimeoutMs?: number;
  /** Worker startup budget — imports of react/jsdom (default 10000ms). */
  startupTimeoutMs?: number;
}

/** A sample instance of a tool's response shape. Arrays carry TWO items so an
 *  island that maps rows re-renders with grown collections — the exact motion
 *  that fires hooks-order violations (C11) with live data. */
export const sampleFromShape = (shape: ShapeType): unknown => {
  switch (shape.kind) {
    case "string": return "sample";
    case "number": return 2;
    case "boolean": return false;
    case "null": return null;
    case "json": return {};
    case "array": return [sampleFromShape(shape.items), sampleFromShape(shape.items)];
    case "object": {
      const value: Record<string, unknown> = {};
      for (const [field, fieldShape] of Object.entries(shape.fields)) {
        value[field] = sampleFromShape(fieldShape);
      }
      return value;
    }
  }
};

const isMutating = (tool: HostToolInfo | undefined): boolean =>
  tool?.risk === "write" || tool?.risk === "destructive";

/** Teaching messages per crash class — routed to repair like any issue. */
const HOOKS_ORDER = /rendered (more|fewer) hooks|change in the order of hooks|#31[01]\b/i;
const NOT_DEFINED = /^([A-Za-z_$][\w$]*) is not defined/;

const renderIssue = (island: string, message: string): string => {
  if (HOOKS_ORDER.test(message)) {
    return `island "${island}" crashed in the smoke render (${message.split("\n")[0]}) — React hooks (useState/useEffect/useMemo/…) must be called at the top level of the component, never inside .map(), loops, or conditions. Hoist the state to the component, or extract the repeated block into its own local component that owns its hooks.`;
  }
  const undefined_ = NOT_DEFINED.exec(message);
  if (undefined_ !== null) {
    return `island "${island}" crashed in the smoke render: ${undefined_[1]} is not defined — an island can only use the ambient scope (React and its hooks, the Kit components, fmt, tools) and names it declares itself; host catalog and prewired components never exist inside an island.`;
  }
  return `island "${island}" crashed when rendered against stubbed tool results: ${message.split("\n")[0]} — the component must render without throwing for any tool data it can receive: guard undefined/empty results before .map/.reduce and render a loading or empty state instead of crashing.`;
};

// ---------------------------------------------------------------------------
// Worker source (CJS eval worker). Embedded as a string so no worker FILE has
// to survive a host bundler; module paths are resolved on the main thread and
// passed in. No backticks/template literals in here — it is itself a literal.
// ---------------------------------------------------------------------------
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const finish = (errors) => { try { parentPort.postMessage({ type: "result", errors }); } catch {} };
(async () => {
  const errors = [];
  const seen = new Set();
  const record = (error) => {
    const message = error instanceof Error ? (error.message || String(error)) : String(error);
    if (!seen.has(message)) { seen.add(message); errors.push(message); }
  };
  // React logs every boundary-caught error loudly, and a chatty island could
  // fill the piped (never-consumed) stdio; the smoke render is a gate, not a
  // console feed.
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  console.info = () => {};
  const { JSDOM } = require(workerData.paths.jsdom);
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  const React = require(workerData.paths.react);
  const { createRoot } = require(workerData.paths.reactDomClient);
  parentPort.postMessage({ type: "ready" });

  // Ambient scope: real React/hooks, pass-through Kit, string fmt, tool stub.
  const scope = { React, ReactDOM: {}, Fragment: React.Fragment };
  for (const name of workerData.reactNames) {
    if (scope[name] === undefined && typeof React[name] === "function") scope[name] = React[name];
  }
  for (const name of workerData.kitNames) {
    const Kit = (props) => React.createElement("div", { "data-kit": name }, props && props.children ? props.children : null);
    Kit.displayName = name;
    scope[name] = Kit;
  }
  const asText = (value) => (value === null || value === undefined ? "" : String(value));
  scope.fmt = { money: asText, dateTime: asText, percent: asText, num: asText, date: asText, time: asText };
  const toolStub = (path) => new Proxy(function () {}, {
    get: (_target, key) => (typeof key === "string" ? toolStub(path.concat(key)) : undefined),
    apply: () => {
      const name = path.join("_");
      const results = workerData.toolResults;
      const value = Object.prototype.hasOwnProperty.call(results, name) ? results[name] : {};
      return new Promise((resolve) => setTimeout(() => resolve(value), 0));
    },
  });
  scope.tools = toolStub([]);

  // Evaluate the compiled island (CJS) with the ambient names as parameters.
  const moduleRef = { exports: {} };
  const names = Object.keys(scope);
  let Component;
  try {
    const factory = new Function("module", "exports", "require", ...names, workerData.compiled);
    factory(moduleRef, moduleRef.exports, () => ({}), ...names.map((name) => scope[name]));
    Component = moduleRef.exports.default || moduleRef.exports;
  } catch (error) {
    record(error);
    return finish(errors);
  }
  if (typeof Component !== "function") {
    record(new Error("the island's default export is not a component"));
    return finish(errors);
  }

  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { record(error); }
    render() { return this.state.failed ? null : this.props.children; }
  }
  dom.window.addEventListener("error", (event) => { if (event.error) record(event.error); });
  const container = dom.window.document.getElementById("root");
  try {
    const root = createRoot(container, {
      onUncaughtError: (error) => record(error),
      onCaughtError: (error) => record(error),
    });
    root.render(React.createElement(Boundary, null, React.createElement(Component, {})));
  } catch (error) {
    record(error);
    return finish(errors);
  }
  // Flush: effects run, the tool stub resolves, setState re-renders land.
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  finish(errors);
})().catch((error) => finish([error instanceof Error ? error.message : String(error)]));
`;

interface WorkerModules {
  paths: { react: string; reactDomClient: string; jsdom: string };
  Worker: typeof import("node:worker_threads").Worker;
}

/** Lazy module resolution, esbuild-pattern: unavailable → gate skips. The
 *  magic comments keep bundlers from walking into jsdom/react-dom. */
const workerModules = (async (): Promise<WorkerModules | undefined> => {
  try {
    const { Worker } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:worker_threads");
    const { createRequire } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:module");
    const resolvers: Array<() => NodeJS.Require> = [
      () => createRequire(import.meta.url),
      () => createRequire(`${process.cwd()}/package.json`),
    ];
    for (const make of resolvers) {
      try {
        const require_ = make();
        return {
          Worker,
          paths: {
            react: require_.resolve("react"),
            reactDomClient: require_.resolve("react-dom/client"),
            jsdom: require_.resolve("jsdom"),
          },
        };
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
})();

/** esbuild, lazily and bundler-safely (same pattern + rationale as engine.ts). */
const esbuildCompile = (async () => {
  try {
    const esbuild = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "esbuild");
    return (source: string): string =>
      esbuild.transformSync(source, { loader: "tsx", format: "cjs", target: "es2020" }).code;
  } catch {
    return undefined;
  }
})();

/** Source-keyed cache: the same island revalidates on every repair round and
 *  end-pass read-through; only changed sources pay for a render. */
const cache = new Map<string, string[]>();
const CACHE_LIMIT = 256;

const renderOne = async (
  modules: WorkerModules,
  island: string,
  compiled: string,
  toolResults: Record<string, unknown>,
  renderTimeoutMs: number,
  startupTimeoutMs: number,
): Promise<string[]> => {
  // The worker deliberately EXECUTES generated island code — that is the
  // gate. Containment: island code is model-generated and has already passed
  // the import/network/tools gates, the worker gets an EMPTY env (no host
  // secrets are readable), require inside the island scope is stubbed, memory
  // is capped, and the main thread hard-terminates on timeout. This is a
  // robustness gate at the model trust level, not a substitute for the jail.
  const worker = new modules.Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      compiled,
      toolResults,
      paths: modules.paths,
      reactNames: ISLAND_AMBIENT_REACT_NAMES,
      kitNames: ISLAND_AMBIENT_KIT_NAMES,
    },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    stderr: true,
    stdout: true,
  });
  try {
    return await new Promise<string[]>((resolve) => {
      let ready = false;
      let timer = setTimeout(() => resolve([]), startupTimeoutMs); // env too slow → skip, not an island fault
      worker.on("message", (message: { type: string; errors?: string[] }) => {
        if (message.type === "ready") {
          ready = true;
          clearTimeout(timer);
          timer = setTimeout(() => resolve([
            renderIssue(island, `the component did not finish rendering within ${renderTimeoutMs}ms (likely an infinite render/effect loop)`),
          ]), renderTimeoutMs);
          return;
        }
        clearTimeout(timer);
        resolve((message.errors ?? []).map((error) => renderIssue(island, error)));
      });
      worker.on("error", (error) => {
        clearTimeout(timer);
        // A worker-level crash after ready is the island's doing; before
        // ready it is the environment's — skip.
        resolve(ready ? [renderIssue(island, error.message)] : []);
      });
      worker.on("exit", () => {
        clearTimeout(timer);
        resolve([]);
      });
    });
  } finally {
    void worker.terminate();
  }
};

/**
 * Smoke-render every island in parallel; returns validation issues (empty =
 * all islands rendered clean, or the environment cannot run the gate).
 */
export const smokeRenderIslands = async (options: SmokeRenderOptions): Promise<string[]> => {
  const names = Object.keys(options.components);
  if (names.length === 0) return [];
  const modules = await workerModules;
  const compile = await esbuildCompile;
  if (modules === undefined || compile === undefined) return [];
  const byName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const issues = await Promise.all(names.map(async (island) => {
    const source = options.components[island] as string;
    const manifest = options.componentTools[island] ?? [];
    const toolResults: Record<string, unknown> = {};
    for (const tool of manifest) {
      if (isMutating(byName.get(tool))) {
        toolResults[tool] = { status: "pending-approval" };
      } else {
        const shape = options.toolShapes?.[tool];
        toolResults[tool] = shape === undefined ? {} : sampleFromShape(shape);
      }
    }
    const key = `${island} ${source} ${JSON.stringify(toolResults)}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let compiled: string;
    try {
      compiled = compile(source);
    } catch {
      return []; // not valid TSX — prepareIslands owns that message
    }
    const result = await renderOne(
      modules,
      island,
      compiled,
      toolResults,
      options.renderTimeoutMs ?? 1000,
      options.startupTimeoutMs ?? 10_000,
    );
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, result);
    return result;
  }));
  return issues.flat();
};
