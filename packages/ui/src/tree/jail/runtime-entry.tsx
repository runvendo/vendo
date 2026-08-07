import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import * as reactDom from "react-dom";
import { createPortal, flushSync } from "react-dom";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { transform } from "sucrase";
// The bundled third-party packages (core's JAIL_BUNDLED_PACKAGES). Imported
// here — not lazily, not from a CDN — because the jail realm has NO network:
// they must already be inside the runtime bundle to be requirable at all.
// clsx + tailwind-merge are real (~8 KB together). zod is a SHIM: real zod cost
// ~23 KB gzip in every host's production bundle, and measured against the real
// captures nothing in the jail ever parses — see zod-shim.ts for the evidence.
import { clsx } from "clsx";
import * as tailwindMerge from "tailwind-merge";
import { zodShim } from "./zod-shim.js";
import { ISLAND_AMBIENT_NAMES, jailPackageUrl, type IslandResolvableModule } from "@vendoai/core";
import { applyThemeVars, postToHost, startFrameProtocol } from "../../embedded-runtime.js";
import {
  Accordion, Badge, BarChart, Button, Callout, Card, CardList, Checkbox, DataTable,
  DatePicker, DateTime, Disclaimer, Divider, DonutChart, EnumBadge, Form, Grid,
  Input, LineChart, Money, Num, Percent, Progress, Row, Select, Sparkline,
  Stack, Stat, Surface, Tabs, Text, Textarea,
  fmt, setKitIntl, type KitIntl,
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
  /** The whole react-dom namespace, published only when a preview installs the
   *  CDN import map: a fetched package's `react-dom` import must resolve to
   *  THIS realm's copy, not to a second one from the CDN. */
  // eslint-disable-next-line no-var
  var __VENDO_JAIL_REACT_DOM_ALL__: typeof reactDom;
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

// Implicit-submission interception (unified-try-surface Defect 2, 2026-07-26):
// the jail sandbox carries no `allow-forms` — no <form> submission may ever
// navigate or POST out of this frame, by design (JailedComponent's iframe
// sandbox is exactly "allow-scripts").
//
// The FIRST fix here was a capture-phase `submit` listener calling
// preventDefault() — browser-verified DEAD: for an implicit submission
// (clicking a submit button, or pressing Enter in a form field) inside a
// sandboxed, non-allow-forms frame, Chromium logs "Blocked form
// submission..." and aborts WITHOUT ever dispatching a cancelable `submit`
// DOM event — so no `submit` listener (this module's, React's synthetic
// onSubmit, or the Kit Form's own wrapper) ever runs at all. The only
// interceptable moment is the act that WOULD trigger the implicit
// submission — the click or keypress — one step upstream of `submit` itself.
//
// Fix: capture-phase `click` and `keydown` listeners find the (submit
// button | Enter-in-field) trigger, preventDefault() on THAT event (stopping
// the browser from ever reaching its own blocked-submission path), then
// re-dispatch a plain, untrusted `submit` Event at the form. An untrusted
// event constructed and dispatched by script carries no browser-native
// default action of its own (only a REAL, trusted implicit-submission
// attempt does), so it reaches every ordinary `submit` listener — Kit's own
// preventDefault wrapper, a raw island's onSubmit, and any future one —
// exactly as if the browser's own submission had fired, with zero risk of
// the sandboxed block re-triggering. The synthetic dispatch is deferred to a
// microtask so it lands after the triggering event finishes its own capture/
// target/bubble dispatch, matching the browser's native default-action
// timing (the default action runs only once the event is fully done).
const submitTarget = (element: Element): (HTMLButtonElement | HTMLInputElement) | null => {
  const submitter = element.closest('button, input[type="submit"], input[type="image"]');
  if (submitter === null) return null;
  if (submitter instanceof HTMLButtonElement) return submitter.type === "submit" ? submitter : null;
  if (submitter instanceof HTMLInputElement) {
    return submitter.type === "submit" || submitter.type === "image" ? submitter : null;
  }
  return null;
};

const fireUntrustedSubmit = (form: HTMLFormElement): void => {
  queueMicrotask(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const submitter = submitTarget(event.target);
  if (submitter === null || submitter.disabled || submitter.form === null) return;
  event.preventDefault();
  fireUntrustedSubmit(submitter.form);
}, { capture: true });

// The Enter-in-a-field implicit submission (the other native trigger the
// spec defines) needs the identical treatment — it bypasses `click`
// entirely, so it hits the SAME blocked-before-any-event Chromium path.
const IMPLICIT_SUBMIT_INPUT_TYPES = new Set([
  "text", "search", "url", "tel", "email", "password", "number",
  "date", "month", "week", "time", "datetime-local",
]);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
  if (!IMPLICIT_SUBMIT_INPUT_TYPES.has(event.target.type) || event.target.form === null) return;
  event.preventDefault();
  fireUntrustedSubmit(event.target.form);
}, { capture: true });

// Defense in depth, kept from the original fix: any OTHER path that still
// manages to dispatch a real, cancelable `submit` event (a form's own
// `requestSubmit()` call, a future browser/engine that behaves closer to
// spec than Chromium's implicit-submission shortcut above) is covered too —
// preventDefault() here only suppresses the sandboxed native action; it does
// not stop propagation, so React's synthetic onSubmit (and the Kit Form's
// own handler) still run normally.
document.addEventListener("submit", (event) => event.preventDefault(), { capture: true });

let root: Root | undefined;
let loadedKey: string | undefined;
let loadedComponent: React.ComponentType<Record<string, unknown>> | undefined;
let requestSequence = 0;
const pendingActions = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

const post = postToHost;

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
  Stack, Row, Grid, Surface, Card, Divider,
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
 * rewrites every static AND dynamic `import` in the SOURCE into a call to this
 * `require`, so no import form a component writes can express a network fetch.
 *
 * That rewrite is a source-level gate, not a security boundary: code the
 * transform cannot see — `new Function("u", "return import(u)")`, or an
 * injected `<script src>` — walks straight past it. The boundary is
 * `script-src`, which names no source expression (no host, no `blob:`, no
 * `data:`), so nothing here can fetch a script from anywhere. It only became
 * one when the nonce came out of that directive: a nonce is readable from the
 * DOM by the very code it is meant to constrain, so generated code could stamp
 * its own remote `<script>` with it (browser-verified — see
 * e2e/exfil-probe.spec.ts).
 *
 * Keyed by `IslandResolvableModule` (the shared allowlist in @vendoai/core —
 * react, the kit-ish specifiers the engine strips, and the bundled third-party
 * packages) so this table, the engine's import gate, and `vendo sync`'s capture
 * cannot drift: a missing or extra key is a compile error. That check is the
 * reason a specifier can never be PERMITTED without also being PROVIDED here.
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
  // Bundled packages. `__esModule: true` is REQUIRED on every entry: without it
  // sucrase's `_interopRequireDefault` wraps the entry a second time, so
  // `import clsx from "clsx"` binds `{ clsx, default }` instead of the function
  // and calling it throws. Default import is the common style for clsx, so
  // omitting this breaks essentially every real host — permitted, but not
  // usable. Both the named and default shapes are provided for each.
  clsx: { __esModule: true, clsx, default: clsx },
  "tailwind-merge": { __esModule: true, ...tailwindMerge, default: tailwindMerge },
  // The shim IS the `z` namespace (see zod-shim.ts), which is what makes
  // `import * as z from "zod"` — Zod 4's documented style — resolve.
  zod: zodShim,
};

/**
 * PREVIEW VENUE ONLY — packages fetched from the one pinned CDN origin, keyed by
 * the import specifier the captured source uses. Empty in every other venue: a
 * host only sends `packages` for a console preview, and without them the jail's
 * CSP names no network source at all.
 */
const cdnPackages = new Map<string, unknown>();

const EXPORTABLE_NAME = /^[A-Za-z_$][\w$]*$/u;
// A destructuring re-export cannot bind a reserved word, and a module namespace
// object always carries `default`.
const RESERVED_NAME = /^(?:default|class|function|const|let|var|new|delete|typeof|instanceof|in|of|if|else|return|this|null|true|false|import|export|void|do|while|for|switch|case|break|continue|catch|try|finally|throw|with|super|extends|yield|await|enum|static|implements|interface|package|private|protected|public)$/u;

/**
 * A `data:` module that re-exports one of this realm's own globals.
 *
 * This is what keeps the CDN's React out of the jail. A CDN package fetched
 * with `?external=react,react-dom` imports bare `react`, and the import map
 * points that at the instance already bundled here. Browser-measured, the
 * alternative — letting the CDN serve a second React — renders nothing and
 * throws `Cannot read properties of null (reading 'useContext')`, because a
 * component's hooks resolve against a dispatcher its own copy never set.
 *
 * `data:` is inline code, so it opens no network channel and grants nothing
 * `'unsafe-eval'` does not already grant; `blob:` stays banned.
 */
function globalModuleUrl(globalName: string, target: object): string {
  const names = Object.keys(target).filter((name) => EXPORTABLE_NAME.test(name) && !RESERVED_NAME.test(name));
  const body = `const M = globalThis.${globalName};\n`
    + "export default M.default === undefined ? M : M.default;\n"
    + (names.length > 0 ? `export const { ${names.join(", ")} } = M;\n` : "");
  return `data:text/javascript,${encodeURIComponent(body)}`;
}

let importMapInstalled = false;

/** Installed once, and only when a preview actually asks for packages: an import
 *  map must precede the realm's first module load, and the jail loads no modules
 *  of its own. */
function installPackageImportMap(): void {
  if (importMapInstalled) return;
  importMapInstalled = true;
  globalThis.__VENDO_JAIL_REACT_DOM_ALL__ = reactDom;
  // No nonce to carry: the jail's `script-src` names `'unsafe-inline'` instead
  // (a nonce is readable off the DOM by the very code this realm sandboxes, so
  // it made the source list moot — see JailedComponent), and an import map is
  // inline script, which that permits.
  const element = document.createElement("script");
  element.type = "importmap";
  element.textContent = JSON.stringify({
    imports: {
      react: globalModuleUrl("__VENDO_JAIL_REACT__", React),
      "react-dom": globalModuleUrl("__VENDO_JAIL_REACT_DOM_ALL__", reactDom),
      "react-dom/client": `data:text/javascript,${encodeURIComponent(
        "const createRoot = globalThis.__VENDO_JAIL_CREATE_ROOT__;\nexport { createRoot };\nexport default { createRoot };\n",
      )}`,
      "react/jsx-runtime": `data:text/javascript,${encodeURIComponent(
        "const R = globalThis.__VENDO_JAIL_REACT__;\nexport const Fragment = R.Fragment;\nexport const jsx = (type, props, key) => R.createElement(type, key === undefined ? props : Object.assign({}, props, { key }));\nexport const jsxs = jsx;\nexport const jsxDEV = jsx;\n",
      )}`,
    },
  });
  document.head.appendChild(element);
}

/**
 * Fetch every pinned package a PREVIEW asked for, and answer with the pins that
 * would not load — CDN unreachable, 404, private, or a pin that is not an exact
 * version. The caller reports those instead of rendering: a require that throws
 * inside a `streaming` surface is an eternal skeleton, which is the failure this
 * whole path exists to avoid.
 */
async function resolvePackages(raw: unknown): Promise<string[]> {
  const pins = stringRecord(raw);
  const wanted = Object.entries(pins).filter(([specifier]) => !cdnPackages.has(specifier));
  if (wanted.length === 0) return [];
  installPackageImportMap();
  const unavailable: string[] = [];
  await Promise.all(wanted.map(async ([specifier, pin]) => {
    const url = jailPackageUrl(pin);
    if (url === null) {
      unavailable.push(pin);
      return;
    }
    try {
      const namespace = await import(/* @vite-ignore */ url) as Record<string, unknown>;
      // `__esModule` for sucrase's default-import interop, exactly as for the
      // bundled packages above.
      cdnPackages.set(specifier, {
        __esModule: true,
        ...namespace,
        default: namespace.default ?? namespace,
      });
    } catch {
      unavailable.push(pin);
    }
  }));
  return unavailable.sort();
}

function jailRequire(specifier: string): unknown {
  if (Object.prototype.hasOwnProperty.call(JAIL_MODULES, specifier)) {
    return (JAIL_MODULES as Record<string, unknown>)[specifier];
  }
  const fromCdn = cdnPackages.get(specifier);
  if (fromCdn !== undefined) return fromCdn;
  throw new Error(`module "${specifier}" is not available in the Vendo jail`);
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

/** Captured host CSS arrives verbatim, `@import` lines included (a Tailwind v4
 *  root ships `@import "tailwindcss"`). The jail CSP has no style network
 *  source, so every `@import` is a guaranteed-refused fetch that logs a CSP
 *  violation on each render — drop the statements before injection; nothing
 *  the jail could ever load is lost. Quote-, escape-, and comment-aware: a
 *  `;` inside a quoted URL must not terminate the statement (it would leave
 *  malformed residue the parser rejects, dropping every later rule), and an
 *  `@import` inside a string or comment is content, not a statement. */
const stripCssImports = (css: string): string => {
  // Copies a quoted string or comment verbatim starting at `i`; returns the
  // index just past it, or `i` when neither starts there.
  const skipToken = (from: number): number => {
    const quote = css[from];
    if (quote === '"' || quote === "'") {
      let i = from + 1;
      while (i < css.length && css[i] !== quote) i += css[i] === "\\" ? 2 : 1;
      return Math.min(i + 1, css.length);
    }
    if (quote === "/" && css[from + 1] === "*") {
      const end = css.indexOf("*/", from + 2);
      return end === -1 ? css.length : end + 2;
    }
    return from;
  };
  let out = "";
  for (let i = 0; i < css.length; ) {
    const token = skipToken(i);
    if (token > i) {
      out += css.slice(i, token);
      i = token;
      continue;
    }
    if (css.startsWith("@import", i)) {
      i += "@import".length;
      while (i < css.length) {
        const inner = skipToken(i);
        if (inner > i) {
          i = inner;
          continue;
        }
        i += 1;
        if (css[i - 1] === ";") break;
      }
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
};

function applyHostStyles(styles: unknown): void {
  document.querySelectorAll("style[data-vendo-host-style]").forEach((element) => element.remove());
  if (!Array.isArray(styles)) return;
  for (const candidate of styles) {
    if (!isRecord(candidate) || typeof candidate.css !== "string") continue;
    const style = document.createElement("style");
    style.dataset.vendoHostStyle = typeof candidate.path === "string" ? candidate.path : "captured";
    // textContent keeps captured CSS as inert data at the postMessage boundary;
    // the unchanged CSP still refuses every non-data network source it names.
    style.textContent = stripCssImports(candidate.css);
    document.head.appendChild(style);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown> | undefined;
  if (!message || message.vendo !== true) return;

  if (message.kind === "render" && typeof message.source === "string") {
    applyThemeVars(message.themeVars);
    // The jail is a separate realm with its own module instances, so the
    // host's ambient currency does not cross the iframe boundary on its own —
    // an island's <Money/> would print "$" while the tree around it prints
    // the host's currency. Re-install it here, before anything renders.
    setKitIntl(message.intl as Partial<KitIntl> | undefined);
    applyHostStyles(message.styles);
    // Packages first: `require` is synchronous, so anything a captured module
    // imports has to be in hand before a line of it evaluates.
    void resolvePackages(message.packages)
      .then(async (unavailable) => {
        if (unavailable.length > 0) {
          post({ kind: "packages-unavailable", packages: unavailable });
          return;
        }
        const result = await renderComponent(
          message.source as string,
          (message.props ?? {}) as Record<string, unknown>,
          message.sourceImports,
          message.subSources,
        );
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

// The frame protocol's inner half lives in ../../embedded-runtime.ts — ONE
// implementation shared with the box app template (blueprint §12.3). The jail
// is one embedded surface among two; it does not own the protocol.
startFrameProtocol(mount, post);
