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
let reactShimUrl: string | undefined;
let requestSequence = 0;
const pendingActions = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();

const post = (message: Record<string, unknown>) => parent.postMessage({ vendo: true, ...message }, "*");

function reactShimSource(): string {
  return `
const R = globalThis.__VENDO_JAIL_REACT__;
const D = globalThis.__VENDO_JAIL_REACT_DOM__;
const J = globalThis.__VENDO_JAIL_JSX__;
export default R;
export const Children=R.Children, Component=R.Component, Fragment=R.Fragment, Profiler=R.Profiler,
PureComponent=R.PureComponent, StrictMode=R.StrictMode, Suspense=R.Suspense,
cloneElement=R.cloneElement, createContext=R.createContext, createElement=R.createElement,
createRef=R.createRef, forwardRef=R.forwardRef, isValidElement=R.isValidElement,
lazy=R.lazy, memo=R.memo, startTransition=R.startTransition, useCallback=R.useCallback,
useContext=R.useContext, useDebugValue=R.useDebugValue, useDeferredValue=R.useDeferredValue,
useEffect=R.useEffect, useId=R.useId, useImperativeHandle=R.useImperativeHandle,
useInsertionEffect=R.useInsertionEffect, useLayoutEffect=R.useLayoutEffect, useMemo=R.useMemo,
useReducer=R.useReducer, useRef=R.useRef, useState=R.useState,
useSyncExternalStore=R.useSyncExternalStore, useTransition=R.useTransition,
use=R.use, useActionState=R.useActionState, useOptimistic=R.useOptimistic, cache=R.cache,
version=R.version;
export const createRoot=globalThis.__VENDO_JAIL_CREATE_ROOT__, createPortal=D.createPortal, flushSync=D.flushSync;
export const jsx=J.jsx, jsxs=J.jsxs;
`;
}

function shimUrl(): string {
  reactShimUrl ??= URL.createObjectURL(new Blob([reactShimSource()], { type: "text/javascript" }));
  return reactShimUrl;
}

function rewriteReactImports(source: string): string {
  const url = JSON.stringify(shimUrl());
  const specifier = "react(?:-dom(?:\\/client)?|\\/jsx(?:-dev)?-runtime)?";
  return source.replace(
    new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)(["'])${specifier}\\2`, "g"),
    (_match, prefix: string) => `${prefix}${url}`,
  );
}

async function load(source: string): Promise<React.ComponentType<Record<string, unknown>>> {
  if (source === loadedSource && loadedComponent) return loadedComponent;
  const compiled = transform(source, {
    transforms: ["typescript", "jsx"],
    production: true,
    jsxRuntime: "classic",
    jsxPragma: "globalThis.__VENDO_JAIL_REACT__.createElement",
    jsxFragmentPragma: "globalThis.__VENDO_JAIL_REACT__.Fragment",
  }).code;
  const moduleSource = rewriteReactImports(compiled);
  const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ url) as { default?: unknown };
    if (typeof module.default !== "function" && typeof module.default !== "object") {
      throw new Error("generated component must have a React default export");
    }
    loadedSource = source;
    loadedComponent = module.default as React.ComponentType<Record<string, unknown>>;
    return loadedComponent;
  } finally {
    URL.revokeObjectURL(url);
  }
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
