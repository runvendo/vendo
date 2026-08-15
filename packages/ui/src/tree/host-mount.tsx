import * as React from "react";
import { Component, useMemo, type ComponentType, type ReactNode } from "react";
import * as ReactDOMClient from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { transform } from "sucrase";
import { clsx } from "clsx";
import * as tailwindMerge from "tailwind-merge";
import type {
  Json,
  ToolOutcome,
} from "@vendoai/core";
import type {
  InClientBundledPackage,
  InClientModule,
} from "@vendoai/apps/contract";
import { zodShim } from "./inclient-zod-shim.js";
import { ContainedNotice } from "./notice.js";

/**
 * 06-apps §9 — the in-client venue: an APPROVED app version's generated code
 * mounts natively in the host page, with full host-page authority (the diff
 * review is the control). This module is the mount path only; the decision to
 * use it is server-authoritative (`payload.inClient.granted`, written
 * exclusively by the runtime's hash-pin verification).
 *
 * Sucrase rewrites every import into a call to a controlled `require` bound to
 * the captured import table, so the approved source reaches exactly React and
 * its captured sub-sources — the module space stays closed even though the code
 * runs with host authority.
 */

/**
 * The in-client module space. Typed `Record<InClientModule |
 * InClientBundledPackage, unknown>` — NOT `Record<string, unknown>` — so it
 * cannot drift from the contract: this path renders APPROVED remixes of the
 * host's OWN components, which are exactly the components that import
 * clsx/tailwind-merge/zod. A missing key is a compile error.
 *
 * zod is a SHIM that refuses to validate loudly rather than silently.
 */
const HOST_MODULES: Record<InClientModule | InClientBundledPackage, unknown> = {
  react: { ...React, default: React },
  "react-dom": { createPortal, flushSync, default: { createPortal, flushSync } },
  "react-dom/client": { ...ReactDOMClient, default: ReactDOMClient },
  "react/jsx-runtime": { jsx, jsxs, Fragment, default: { jsx, jsxs, Fragment } },
  "react/jsx-dev-runtime": { jsx, jsxs, jsxDEV: jsx, Fragment, default: { jsx, jsxs, Fragment } },
  // `__esModule: true` so a `import cn from "clsx"` default read interops.
  clsx: { __esModule: true, clsx, default: clsx },
  "tailwind-merge": { __esModule: true, ...tailwindMerge, default: tailwindMerge },
  zod: zodShim,
};

export interface InClientSubSource {
  source: string;
  imports: Record<string, string>;
}

export interface InClientStyle {
  path: string;
  css: string;
}

/** Structural copy of the additive pin-baseline furnishing; ui depends on core only. */
export interface InClientFurnishing {
  sourceImports?: Record<string, string>;
  subSources?: Record<string, InClientSubSource>;
  sampleProps?: Record<string, unknown>;
  styles?: InClientStyle[];
}

interface VirtualSource {
  source: string;
  imports: Record<string, string>;
}

const compile = (source: string): string => transform(source, {
  transforms: ["typescript", "jsx", "imports"],
  production: true,
  jsxRuntime: "automatic",
}).code;

/** Compile and evaluate one approved component plus its captured sub-sources. */
export function evaluateApprovedComponent(
  source: string,
  furnishing?: Pick<InClientFurnishing, "sourceImports" | "subSources">,
): ComponentType<Record<string, unknown>> {
  const entryId = "\0vendo-inclient-entry";
  const modules = Object.create(null) as Record<string, VirtualSource>;
  for (const [id, sub] of Object.entries(furnishing?.subSources ?? {})) {
    if (typeof sub.source === "string") {
      modules[id] = { source: sub.source, imports: { ...(sub.imports ?? {}) } };
    }
  }
  modules[entryId] = { source, imports: { ...(furnishing?.sourceImports ?? {}) } };
  const compiled = Object.create(null) as Record<string, string>;
  for (const [id, module] of Object.entries(modules)) compiled[id] = compile(module.source);

  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const evaluateModule = (id: string): Record<string, unknown> => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached.exports;
    const descriptor = modules[id];
    if (descriptor === undefined) throw new Error(`captured module "${id}" is unavailable`);
    const moduleRecord = { exports: {} as Record<string, unknown> };
    cache.set(id, moduleRecord);
    const localRequire = (specifier: string): unknown => {
      // The declaration stays narrowly typed (that is the drift guarantee); the
      // lookup is by arbitrary specifier, so it reads through a string view.
      if (Object.prototype.hasOwnProperty.call(HOST_MODULES, specifier)) {
        return (HOST_MODULES as Record<string, unknown>)[specifier];
      }
      const target = descriptor.imports[specifier];
      if (target !== undefined && Object.prototype.hasOwnProperty.call(modules, target)) {
        return evaluateModule(target);
      }
      throw new Error(`module "${specifier}" is not available to an in-client component`);
    };
    const evaluate = new Function("require", "module", "exports", compiled[id]!) as (
      require: typeof localRequire,
      module: typeof moduleRecord,
      exports: Record<string, unknown>,
    ) => void;
    evaluate(localRequire, moduleRecord, moduleRecord.exports);
    return moduleRecord.exports;
  };

  const loaded = evaluateModule(entryId) as { default?: unknown };
  if (typeof loaded.default !== "function" && typeof loaded.default !== "object") {
    throw new Error("approved component must have a React default export");
  }
  return loaded.default as ComponentType<Record<string, unknown>>;
}

export interface InClientMountProps {
  name: string;
  source: string;
  /** Live tree props, already host-bound ($action → functions). */
  props?: Record<string, unknown>;
  furnishing?: InClientFurnishing;
  onAction(action: string, payload?: Json): Promise<ToolOutcome>;
  onStateSet(key: string, value: Json): void;
}

interface DropBackState {
  failed?: string;
}

/** The drop-back: a failed mount says so in-surface and renders nothing else. */
const dropBack = (name: string, message: string) => (
  <ContainedNotice label="In-client mount failed" outcome="error">
    {`${name} failed in the host page: ${message}`}
  </ContainedNotice>
);

/** A failed host-page mount drops back to the notice, loudly. */
class InClientBoundary extends Component<
  { name: string; children: ReactNode },
  DropBackState
> {
  override state: DropBackState = {};

  static getDerivedStateFromError(error: Error): DropBackState {
    return { failed: error.message };
  }

  override render() {
    if (this.state.failed === undefined) return this.props.children;
    return dropBack(this.props.name, this.state.failed);
  }
}

/**
 * 08-ui §5 amendment (06-apps §9) — mount ONE approved generated component in
 * the host page. Rendered only when the server's hash-pinned verdict granted
 * the in-client venue; every failure path drops back to a contained notice.
 */
export function InClientMount({
  name,
  source,
  props,
  furnishing,
  onAction,
  onStateSet,
}: InClientMountProps) {
  const evaluated = useMemo(() => {
    // SSR-safe: evaluation is a browser concern; the server renders nothing
    // rather than executing approved code during SSR.
    if (typeof window === "undefined") return { kind: "ssr" as const };
    try {
      return { kind: "ok" as const, Component: evaluateApprovedComponent(source, furnishing) };
    } catch (error) {
      return {
        kind: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, [furnishing, source]);

  if (evaluated.kind === "ssr") return null;
  if (evaluated.kind === "error") return dropBack(name, evaluated.message);
  const Approved = evaluated.Component;
  const vendo = {
    action: (action: string, payload?: Json) => onAction(action, payload),
    setState: (key: string, value: Json) => onStateSet(key, value),
  };
  // A node without live props renders the captured sampleProps rehearsal stub.
  // The approved version is hash-pinned, so promotion must never change what
  // props the component sees.
  const effectiveProps = props ?? furnishing?.sampleProps ?? {};
  return (
    <InClientBoundary name={name}>
      <div data-vendo-inclient-mount={name}>
        <Approved {...effectiveProps} vendo={vendo} />
      </div>
    </InClientBoundary>
  );
}
