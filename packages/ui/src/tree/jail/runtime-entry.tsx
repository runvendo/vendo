import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { transform } from "sucrase";
import { ISLAND_AMBIENT_NAMES, type IslandResolvableModule } from "@vendoai/core";
import {
  Accordion, Badge, BarChart, Button, Callout, CardList, Checkbox, DataTable,
  DatePicker, DateTime, Disclaimer, Divider, DonutChart, EnumBadge, Form, Grid,
  Input, LineChart, Money, Num, Percent, Progress, Row, Select, Sparkline,
  Stack, Stat, Surface, Tabs, Text, Textarea,
  applyFormat, formatDateTime, formatMoney, formatNum, formatPercent,
} from "../../kit/index.js";

declare global {
  // These globals are visible only inside the opaque-origin jail realm.
  // eslint-disable-next-line no-var
  var __VENDO_JAIL_REACT__: typeof React;
  // eslint-disable-next-line no-var
  var __VENDO_JAIL_CREATE_ROOT__: typeof createRoot;
  // eslint-disable-next-line no-var
  var __VENDO_JAIL_REACT_DOM__: { createPortal: typeof createPortal; flushSync: typeof flushSync };
  // eslint-disable-next-line no-var
  var __VENDO_JAIL_JSX__: { jsx: typeof jsx; jsxs: typeof jsxs; Fragment: typeof Fragment };
}

globalThis.__VENDO_JAIL_REACT__ = React;
globalThis.__VENDO_JAIL_CREATE_ROOT__ = createRoot;
globalThis.__VENDO_JAIL_REACT_DOM__ = { createPortal, flushSync };
globalThis.__VENDO_JAIL_JSX__ = { jsx, jsxs, Fragment };

const mount = document.createElement("div");
mount.id = "vendo-jail-root";
// Contain first/last-child margins inside the measured box. Otherwise those
// margins can sit outside the mount and be clipped even when its own height is
// reported exactly.
mount.style.display = "flow-root";
document.body.appendChild(mount);

let root: Root | undefined;
let loadedKey: string | undefined;
let loadedComponent: React.ComponentType<Record<string, unknown>> | undefined;
let requestSequence = 0;
const pendingActions = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

const post = (message: Record<string, unknown>) => parent.postMessage({ vendo: true, ...message }, "*");

/**
 * W4b §2 — the ambient `tools` API. `tools.a.b(args)` posts a `tool-call`
 * over the bridge; the HOST resolves the literal member chain against the
 * island's compiler-stamped manifest and routes an allowed call through the
 * EXACT same guarded pipe as tree actions (reads per read policy, mutations
 * pause at the approval gate and complete after approve — the W0 fix). The
 * jail side is pure transport: enforcement never trusts this realm.
 */
const pendingToolCalls = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

function requestToolCall(path: readonly string[], args: unknown): Promise<unknown> {
  const requestId = `jail-tool-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingToolCalls.set(requestId, { resolve, reject });
    post({ kind: "tool-call", requestId, path: [...path], ...(args === undefined ? {} : { args }) });
  });
}

/** Build the ambient `tools` value: every property access extends the literal
 *  member chain, a call ships the chain + args to the host. The manifest
 *  lives host-side; an out-of-manifest chain simply comes back `blocked`. */
const makeToolsAmbient = (path: readonly string[]): unknown =>
  new Proxy(Object.assign(() => undefined, {}) as () => undefined, {
    get: (_target, property) =>
      typeof property === "string" ? makeToolsAmbient([...path, property]) : undefined,
    apply: (_target, _thisArg, args: unknown[]) => requestToolCall(path, args[0]),
  });

/**
 * W4b §1 — the ambient island scope (react-live pattern): React + hooks, the
 * ENTIRE Kit, charts, and `fmt` are simply in scope — island code has no
 * imports. The name list is pinned to `ISLAND_AMBIENT_NAMES` in @vendoai/core
 * (shared with the engine's prompt + strip pass) by the typed record below.
 */
const fmt = {
  money: formatMoney,
  percent: formatPercent,
  num: formatNum,
  dateTime: formatDateTime,
  format: applyFormat,
};

const AMBIENT_SCOPE: Record<(typeof ISLAND_AMBIENT_NAMES)[number], unknown> = {
  React,
  ReactDOM: { createPortal, flushSync },
  Fragment,
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  useReducer: React.useReducer,
  useId: React.useId,
  useLayoutEffect: React.useLayoutEffect,
  useTransition: React.useTransition,
  useDeferredValue: React.useDeferredValue,
  useSyncExternalStore: React.useSyncExternalStore,
  Stack, Row, Grid, Surface, Divider,
  Text, Money, DateTime, Percent, Num, EnumBadge,
  DataTable, CardList, Stat, Badge,
  LineChart, BarChart, DonutChart, Sparkline, Progress,
  Input, Select, DatePicker, Textarea, Checkbox, Button, Form, Disclaimer,
  Tabs, Callout, Accordion,
  fmt,
  tools: makeToolsAmbient([]),
};

/** The Kit's exports as a resolvable module, for habit imports the engine has
 *  not stripped yet (streaming partials) — same objects as the ambient scope,
 *  never a second bundle. */
const KIT_MODULE_EXPORTS = {
  ...AMBIENT_SCOPE,
  default: AMBIENT_SCOPE,
};

/**
 * The ONLY modules generated code can reach. Sucrase's `imports` transform
 * rewrites every static AND dynamic `import` into a call to this `require`,
 * so no module-loader network fetch can ever be expressed — the browser-
 * verified escape (a blob-ESM `import("https://…")` initiating a request
 * despite `script-src`) is closed at the loader itself, and `script-src`
 * carries no `blob:`/host sources as the second wall.
 *
 * Keyed by `IslandResolvableModule` (the shared allowlist in @vendoai/core —
 * react plus the kit-ish specifiers the engine strips) so this table, the
 * engine's strip pass, and the import gate cannot drift: a missing or extra
 * key is a compile error.
 */
const JAIL_MODULES: Record<IslandResolvableModule, unknown> = {
  react: { ...React, default: React },
  "react-dom": { createPortal, flushSync, default: { createPortal, flushSync } },
  "react-dom/client": { createRoot, default: { createRoot } },
  "react/jsx-runtime": { jsx, jsxs, Fragment, default: { jsx, jsxs, Fragment } },
  "react/jsx-dev-runtime": { jsx, jsxs, jsxDEV: jsx, Fragment, default: { jsx, jsxs, Fragment } },
  "@vendoai/ui": KIT_MODULE_EXPORTS,
  "@vendoai/ui/kit": KIT_MODULE_EXPORTS,
  "@vendoai/kit": KIT_MODULE_EXPORTS,
  "@vendoai/vendo": KIT_MODULE_EXPORTS,
  "@vendo/kit": KIT_MODULE_EXPORTS,
  "vendo/kit": KIT_MODULE_EXPORTS,
};

function jailRequire(specifier: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(JAIL_MODULES, specifier)) {
    throw new Error(`module "${specifier}" is not available in the Vendo jail`);
  }
  return (JAIL_MODULES as Record<string, unknown>)[specifier];
}

// A module's own top-level `const Badge = …` must win over the ambient
// parameter of the same name. Redeclaring a parameter with let/const/class is
// a SyntaxError at Function construction, so drop the colliding name(s) and
// retry; the engine messages differ (V8 / SpiderMonkey / JSC), hence the
// pattern list. If a collision cannot be attributed, fall back to the bare
// pre-ambient evaluation so legacy islands keep rendering.
const REDECLARATION_PATTERNS = [
  /Identifier '([^']+)' has already been declared/,
  /redeclaration of (?:formal parameter|var|let|const|class) ([\w$]+)/,
  /Cannot declare a (?:let|const|class) variable twice: '?([\w$]+)'?/,
];

function evaluateWithAmbientScope(
  compiled: string,
  localRequire: (specifier: string) => unknown,
  moduleRecord: { exports: Record<string, unknown> },
): void {
  let names = ISLAND_AMBIENT_NAMES.filter((name) => name in AMBIENT_SCOPE);
  for (;;) {
    let evaluate: (...bindings: unknown[]) => void;
    try {
      evaluate = new Function("require", "module", "exports", ...names, compiled) as typeof evaluate;
    } catch (error) {
      if (error instanceof SyntaxError && names.length > 0) {
        const identifier = REDECLARATION_PATTERNS
          .map((pattern) => pattern.exec(error.message)?.[1])
          .find((name) => name !== undefined && (names as readonly string[]).includes(name));
        names = identifier === undefined ? [] : names.filter((name) => name !== identifier);
        continue;
      }
      throw error;
    }
    evaluate(
      localRequire,
      moduleRecord,
      moduleRecord.exports,
      ...names.map((name) => AMBIENT_SCOPE[name as keyof typeof AMBIENT_SCOPE]),
    );
    return;
  }
}

interface VirtualSource {
  source: string;
  imports: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringRecord(value: unknown): Record<string, string> {
  const record = Object.create(null) as Record<string, string>;
  if (!isRecord(value)) return record;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") record[key] = child;
  }
  return record;
}

function virtualSources(value: unknown): Record<string, VirtualSource> {
  const modules = Object.create(null) as Record<string, VirtualSource>;
  if (!isRecord(value)) return modules;
  for (const [id, candidate] of Object.entries(value)) {
    if (!isRecord(candidate) || typeof candidate.source !== "string") continue;
    modules[id] = { source: candidate.source, imports: stringRecord(candidate.imports) };
  }
  return modules;
}

function compile(source: string): string {
  return transform(source, {
    transforms: ["typescript", "jsx", "imports"],
    production: true,
    jsxRuntime: "classic",
    jsxPragma: "globalThis.__VENDO_JAIL_REACT__.createElement",
    jsxFragmentPragma: "globalThis.__VENDO_JAIL_REACT__.Fragment",
  }).code;
}

async function load(
  source: string,
  rawSourceImports: unknown,
  rawSubSources: unknown,
): Promise<React.ComponentType<Record<string, unknown>>> {
  const sourceImports = stringRecord(rawSourceImports);
  const subSources = virtualSources(rawSubSources);
  const key = JSON.stringify({ source, sourceImports, subSources });
  if (key === loadedKey && loadedComponent) return loadedComponent;
  const entryId = "\u0000vendo-entry";
  const modules = Object.assign(Object.create(null) as Record<string, VirtualSource>, subSources);
  modules[entryId] = { source, imports: sourceImports };
  // Sucrase compiles the fork and every captured source in this single load
  // cycle; evaluation stays behind a per-module require bound to the captured
  // import table. No specifier outside that table can reach a host loader.
  const compiled = Object.create(null) as Record<string, string>;
  for (const [id, module] of Object.entries(modules)) compiled[id] = compile(module.source);
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const evaluateModule = (id: string): Record<string, unknown> => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached.exports;
    const descriptor = modules[id];
    if (descriptor === undefined) throw new Error(`captured module "${id}" is unavailable in the Vendo jail`);
    const moduleRecord = { exports: {} as Record<string, unknown> };
    cache.set(id, moduleRecord);
    const localRequire = (specifier: string): unknown => {
      if (Object.prototype.hasOwnProperty.call(JAIL_MODULES, specifier)) return jailRequire(specifier);
      const target = descriptor.imports[specifier];
      if (target === undefined || !Object.prototype.hasOwnProperty.call(modules, target)) return jailRequire(specifier);
      return evaluateModule(target);
    };
    // 'unsafe-eval' is deliberately allowed in the jail CSP: evaluation is the
    // jail's whole job; NETWORK is what the jail forbids.
    evaluateWithAmbientScope(compiled[id]!, localRequire, moduleRecord);
    return moduleRecord.exports;
  };
  const loaded = evaluateModule(entryId) as { default?: unknown };
  if (typeof loaded.default !== "function" && typeof loaded.default !== "object") {
    throw new Error("generated component must have a React default export");
  }
  loadedKey = key;
  loadedComponent = loaded.default as React.ComponentType<Record<string, unknown>>;
  return loadedComponent;
}

function requestAction(action: string, payload?: unknown): Promise<unknown> {
  const requestId = `jail-action-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingActions.set(requestId, { resolve, reject });
    post({ kind: "action", requestId, action, ...(payload === undefined ? {} : { payload }) });
  });
}

function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrate);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$action === "string") {
    const payload = hydrate(record.payload);
    return () => requestAction(record.$action as string, payload);
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, hydrate(child)]));
}

class RuntimeBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    post({ kind: "error", message: error.message });
  }

  render() {
    return this.state.error ? null : this.props.children;
  }
}

async function renderComponent(
  source: string,
  rawProps: Record<string, unknown>,
  sourceImports?: unknown,
  subSources?: unknown,
): Promise<"ready" | "empty" | "error"> {
  const Component = await load(source, sourceImports, subSources);
  const props = hydrate(rawProps) as Record<string, unknown>;
  props.vendo = {
    action: requestAction,
    setState(key: string, value: unknown) {
      post({ kind: "state-set", key, value });
    },
  };
  const renderRoot = root ??= createRoot(mount);
  const boundaryRef = React.createRef<RuntimeBoundary>();
  // Commit before classifying the result. React root.render is concurrent by
  // default, so inspecting the mount immediately after it would report a
  // false empty result before the first commit.
  flushSync(() => {
    renderRoot.render(
      <RuntimeBoundary ref={boundaryRef}>
        <Component {...props} />
      </RuntimeBoundary>,
    );
  });
  if (boundaryRef.current?.state.error) return "error";
  return mount.hasChildNodes() ? "ready" : "empty";
}

/** Host brand tokens: only --vendo-* custom properties may cross into the jail,
    so generated code styled with the theme variables matches the host (06 §5). */
function applyThemeVars(vars: unknown): void {
  if (typeof vars !== "object" || vars === null) return;
  const rootStyle = document.documentElement.style;
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof value === "string" && /^--vendo-[a-z0-9-]+$/.test(key)) {
      rootStyle.setProperty(key, value);
    }
  }
  document.body.style.fontFamily = "var(--vendo-font-family, system-ui, sans-serif)";
  document.body.style.color = "var(--vendo-color-text, #16161a)";
  document.body.style.fontSize = "var(--vendo-font-size, 15px)";
}

function applyHostStyles(styles: unknown): void {
  document.querySelectorAll("style[data-vendo-host-style]").forEach((element) => element.remove());
  if (!Array.isArray(styles)) return;
  for (const candidate of styles) {
    if (!isRecord(candidate) || typeof candidate.css !== "string") continue;
    const style = document.createElement("style");
    style.dataset.vendoHostStyle = typeof candidate.path === "string" ? candidate.path : "captured";
    // textContent keeps captured CSS as inert data at the postMessage boundary;
    // the unchanged CSP still refuses every non-data network source it names.
    style.textContent = candidate.css;
    document.head.appendChild(style);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown> | undefined;
  if (!message || message.vendo !== true) return;

  if (message.kind === "render" && typeof message.source === "string") {
    applyThemeVars(message.themeVars);
    applyHostStyles(message.styles);
    void renderComponent(
      message.source,
      (message.props ?? {}) as Record<string, unknown>,
      message.sourceImports,
      message.subSources,
    )
      .then((result) => {
        if (result === "ready") post({ kind: "ready" });
        else if (result === "empty") post({ kind: "empty" });
      })
      .catch((error: unknown) => post({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    return;
  }

  if (message.kind === "action-result" && typeof message.requestId === "string") {
    const pending = pendingActions.get(message.requestId);
    if (!pending) return;
    pendingActions.delete(message.requestId);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.outcome);
    return;
  }

  // W4b §2 — the ambient tools reply. `ok` unwraps to the tool OUTPUT (so
  // `(await tools.x.y(args)).data` reads naturally); `error`/`blocked` reject;
  // anything else (pending-approval, connect-required) resolves as the outcome
  // value so the island can render a pending state — the effect itself lands
  // through the host's approve→resume seam, never through this promise.
  if (message.kind === "tool-result" && typeof message.requestId === "string") {
    const pending = pendingToolCalls.get(message.requestId);
    if (!pending) return;
    pendingToolCalls.delete(message.requestId);
    if (message.error !== undefined) {
      pending.reject(new Error(String(message.error)));
      return;
    }
    const outcome = message.outcome as Record<string, unknown> | undefined;
    if (outcome === undefined || typeof outcome !== "object") {
      pending.reject(new Error("malformed tool outcome"));
    } else if (outcome.status === "ok") {
      pending.resolve(outcome.output);
    } else if (outcome.status === "error") {
      const error = outcome.error as { message?: unknown } | undefined;
      pending.reject(new Error(typeof error?.message === "string" ? error.message : "tool call failed"));
    } else if (outcome.status === "blocked") {
      pending.reject(new Error(typeof outcome.reason === "string" ? outcome.reason : "tool call blocked"));
    } else {
      pending.resolve(outcome);
    }
  }
});

const VIEWPORT_BLOCK_UNIT = /(?:d|s|l)?v(?:h|b)(?![a-z])/iu;
const VIEWPORT_BLOCK_PROPERTIES = ["height", "min-height", "block-size", "min-block-size"] as const;

let lastReportedHeight: number | undefined;
let mutationObserver: MutationObserver | undefined;

function contentHeight(): number {
  const elements = [mount, ...mount.querySelectorAll<HTMLElement>("[style]")];

  // A generated root commonly uses min-height:100vh. Inside an auto-sized
  // iframe, that makes its "content" depend on the previous host height. An
  // auto-height surface has no independent block viewport, so normalize only
  // inline viewport-relative block constraints to their content-sized forms.
  for (const element of elements) {
    for (const property of VIEWPORT_BLOCK_PROPERTIES) {
      const value = element.style.getPropertyValue(property);
      if (!VIEWPORT_BLOCK_UNIT.test(value)) continue;
      element.style.setProperty(property, property.startsWith("min-") ? "0" : "auto", "important");
    }
  }

  const height = Math.ceil(Math.max(mount.getBoundingClientRect().height, mount.scrollHeight));
  // Attribute observation catches state-driven constraint changes. Discard
  // the normalization mutations themselves so they cannot loop.
  mutationObserver?.takeRecords();
  return height;
}

function reportContentHeight(): void {
  const height = contentHeight();
  if (height === lastReportedHeight) return;
  lastReportedHeight = height;
  post({ kind: "resize", height });
}

if (typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(reportContentHeight);
  // The mount changes for content growth; observing viewport-owned html/body
  // would reintroduce the host/frame feedback path.
  observer.observe(mount);
}

if (typeof MutationObserver !== "undefined") {
  mutationObserver = new MutationObserver(reportContentHeight);
  // React can add a new viewport constraint without changing the current box,
  // so also react to render mutations and normalize before measuring.
  mutationObserver.observe(mount, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

post({ kind: "booted" });
