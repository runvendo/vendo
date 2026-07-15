import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { transform } from "sucrase";

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
let loadedSource: string | undefined;
let loadedComponent: React.ComponentType<Record<string, unknown>> | undefined;
let requestSequence = 0;
const pendingActions = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

const post = (message: Record<string, unknown>) => parent.postMessage({ vendo: true, ...message }, "*");

/**
 * The ONLY modules generated code can reach. Sucrase's `imports` transform
 * rewrites every static AND dynamic `import` into a call to this `require`,
 * so no module-loader network fetch can ever be expressed — the browser-
 * verified escape (a blob-ESM `import("https://…")` initiating a request
 * despite `script-src`) is closed at the loader itself, and `script-src`
 * carries no `blob:`/host sources as the second wall.
 */
const JAIL_MODULES: Record<string, unknown> = {
  react: { ...React, default: React },
  "react-dom": { createPortal, flushSync, default: { createPortal, flushSync } },
  "react-dom/client": { createRoot, default: { createRoot } },
  "react/jsx-runtime": { jsx, jsxs, Fragment, default: { jsx, jsxs, Fragment } },
  "react/jsx-dev-runtime": { jsx, jsxs, jsxDEV: jsx, Fragment, default: { jsx, jsxs, Fragment } },
};

function jailRequire(specifier: string): unknown {
  const module = JAIL_MODULES[specifier];
  if (module === undefined) {
    throw new Error(`module "${specifier}" is not available in the Vendo jail`);
  }
  return module;
}

async function load(source: string): Promise<React.ComponentType<Record<string, unknown>>> {
  if (source === loadedSource && loadedComponent) return loadedComponent;
  const compiled = transform(source, {
    transforms: ["typescript", "jsx", "imports"],
    production: true,
    jsxRuntime: "classic",
    jsxPragma: "globalThis.__VENDO_JAIL_REACT__.createElement",
    jsxFragmentPragma: "globalThis.__VENDO_JAIL_REACT__.Fragment",
  }).code;
  const moduleExports: { default?: unknown } = {};
  const moduleRecord = { exports: moduleExports };
  // 'unsafe-eval' is deliberately allowed in the jail CSP: evaluation is the
  // jail's whole job; NETWORK is what the jail forbids.
  const evaluate = new Function("require", "module", "exports", compiled) as (
    require: typeof jailRequire,
    module: typeof moduleRecord,
    exports: typeof moduleExports,
  ) => void;
  evaluate(jailRequire, moduleRecord, moduleExports);
  const loaded = moduleRecord.exports as { default?: unknown };
  if (typeof loaded.default !== "function" && typeof loaded.default !== "object") {
    throw new Error("generated component must have a React default export");
  }
  loadedSource = source;
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
): Promise<"ready" | "empty" | "error"> {
  const Component = await load(source);
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

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown> | undefined;
  if (!message || message.vendo !== true) return;

  if (message.kind === "render" && typeof message.source === "string") {
    applyThemeVars(message.themeVars);
    void renderComponent(message.source, (message.props ?? {}) as Record<string, unknown>)
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
