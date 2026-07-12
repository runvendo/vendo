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

async function renderComponent(source: string, rawProps: Record<string, unknown>): Promise<void> {
  const Component = await load(source);
  const props = hydrate(rawProps) as Record<string, unknown>;
  props.vendo = {
    action: requestAction,
    setState(key: string, value: unknown) {
      post({ kind: "state-set", key, value });
    },
  };
  root ??= createRoot(mount);
  root.render(
    <RuntimeBoundary>
      <Component {...props} />
    </RuntimeBoundary>,
  );
}

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown> | undefined;
  if (!message || message.vendo !== true) return;

  if (message.kind === "render" && typeof message.source === "string") {
    void renderComponent(message.source, (message.props ?? {}) as Record<string, unknown>)
      .then(() => post({ kind: "ready" }))
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

if (typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(() => {
    post({ kind: "resize", height: document.documentElement.scrollHeight });
  });
  observer.observe(document.documentElement);
}

post({ kind: "booted" });
