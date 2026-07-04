"use client";

/**
 * The generic sandbox surface for generated nodes: fetches the React shim +
 * components host bundle from `public/flowlet/` (copied there by
 * `flowlet init`), wires `flowlet.dispatch` to the policy-governed action
 * route (single-use approval tokens), and renders the shell's ApprovalCard
 * when the policy answers "approve".
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UINode, ActionRequest, ActionResult, RegisteredComponent } from "@flowlet/core";
import { FlowletStage } from "@flowlet/react";
import { ApprovalCard } from "@flowlet/shell";
import { prewiredComponents, brandToCssVars, mapBrandToTheme } from "@flowlet/components";
import type { BrandTokens } from "@flowlet/components/theme";
import { NAVIGATE_ACTION, isSafeAppPath } from "./navigate";

interface StageEnv {
  modules?: Record<string, string>;
  css?: string;
  tailwindRuntimeSrc?: string;
}

interface Sources {
  react: string;
  bundle: string;
  /** Furnished environment (remix-fidelity), when `flowlet sync` produced one.
   *  Fetched HOST-side and passed as strings; the stage blobs them so the
   *  iframe CSP never changes. Absent → bare sandbox, byte-identical to before. */
  env?: StageEnv;
}

interface EnvImportMap {
  imports?: Record<string, string>;
}

/** Fetch the flowlet-sync env (import map + vendored modules + host CSS) on the
 *  host origin. Missing env is normal (fresh install / no sync) — returns
 *  undefined, never throws. */
async function loadEnv(): Promise<StageEnv | undefined> {
  const mapRes = await fetch("/flowlet/env/import-map.json").catch(() => null);
  const css = await fetch("/flowlet/env/host.css")
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  const tw = await fetch("/flowlet/env/tailwind.js")
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  let modules: Record<string, string> | undefined;
  if (mapRes?.ok) {
    const map = (await mapRes.json().catch(() => ({}))) as EnvImportMap;
    const entries = await Promise.all(
      Object.entries(map.imports ?? {}).map(async ([specifier, rel]) => {
        const url = rel.replace(/^\.\//, "/flowlet/env/");
        const src = await fetch(url).then((r) => (r.ok ? r.text() : undefined)).catch(() => undefined);
        return src !== undefined ? ([specifier, src] as const) : null;
      }),
    );
    const kept = entries.filter((e): e is readonly [string, string] => e !== null);
    if (kept.length > 0) modules = Object.fromEntries(kept);
  }
  if (!modules && !css && !tw) return undefined;
  return { ...(modules ? { modules } : {}), ...(css ? { css } : {}), ...(tw ? { tailwindRuntimeSrc: tw } : {}) };
}

let sourcesPromise: Promise<Sources> | null = null;
function loadSources(): Promise<Sources> {
  // Module-level memo: fetch once per page, shared by every stage instance.
  if (!sourcesPromise) {
    sourcesPromise = Promise.all([
      fetch("/flowlet/react-runtime.js").then((r) => {
        if (!r.ok) throw new Error("react shim missing — run `flowlet init` to copy sandbox assets into public/flowlet/");
        return r.text();
      }),
      fetch("/flowlet/components-sandbox.js").then((r) => {
        if (!r.ok) throw new Error("components bundle missing — run `flowlet init` to copy sandbox assets into public/flowlet/");
        return r.text();
      }),
      loadEnv(),
    ]).then(([react, bundle, env]) => ({ react, bundle, ...(env ? { env } : {}) }));
    sourcesPromise.catch(() => {
      sourcesPromise = null; // allow retry on failure
    });
  }
  return sourcesPromise;
}

interface PendingApproval {
  req: ActionRequest;
  settle: (approved: boolean) => void;
}

interface ActionResponse {
  result?: unknown;
  needsApproval?: boolean;
  approvalToken?: string;
  error?: string;
}

async function postAction(
  basePath: string,
  action: string,
  payload: unknown,
  approvalToken?: string,
): Promise<ActionResponse> {
  const res = await fetch(`${basePath}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload, ...(approvalToken ? { approvalToken } : {}) }),
  });
  const json = (await res.json()) as ActionResponse;
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return json;
}

export interface SandboxStageProps {
  node: UINode;
  brand: BrandTokens;
  components: RegisteredComponent[];
  basePath: string;
  /** Host router navigation for the reserved flowlet.navigate action (from the
   *  link/router shims). Kept as a prop so this package stays framework-
   *  version-agnostic; FlowletRoot wires `useRouter().push`. Default:
   *  `location.assign`, still validated same-app first. */
  onNavigate?: (href: string) => void;
}

export function SandboxStage({ node, brand, components, basePath, onNavigate }: SandboxStageProps): ReactNode {
  const [sources, setSources] = useState<Sources | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Pending approvals keyed by requestId: concurrent gated dispatches each get
  // their own card. settleOne is idempotent per id.
  const [pending, setPending] = useState<Map<string, PendingApproval>>(new Map());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const mounted = useRef(true);
  // Reset on every (re)mount: StrictMode dev runs mount → cleanup → mount, and
  // a cleanup-only effect would leave `mounted` false forever.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Unmounting with approvals parked: settle them all as declined so the
      // host-side dispatch promises never leak.
      for (const p of pendingRef.current.values()) p.settle(false);
    };
  }, []);

  const settleOne = (requestId: string, approved: boolean) => {
    const entry = pendingRef.current.get(requestId);
    if (!entry) return; // idempotent: already settled/removed
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
    entry.settle(approved);
  };

  useEffect(() => {
    loadSources().then(
      (s) => {
        if (mounted.current) setSources(s);
      },
      (e) => {
        if (mounted.current) setLoadError(String(e.message ?? e));
      },
    );
  }, []);

  if (loadError) return <div data-testid="stage-load-error">Sandbox unavailable: {loadError}</div>;
  if (!sources) return <div data-testid="stage-loading" aria-busy="true" />;

  const onAction = async (req: ActionRequest): Promise<ActionResult> => {
    // Reserved navigation from the link/router shims: handled here, never sent
    // to /action. Validate the href (same-app path only) before touching the
    // host router — a generated view cannot navigate off-site or run a scheme.
    if (req.action === NAVIGATE_ACTION) {
      const href = (req.payload as { href?: unknown } | undefined)?.href;
      if (isSafeAppPath(href)) {
        if (onNavigate) onNavigate(href);
        else if (typeof location !== "undefined") location.assign(href);
        return { result: { navigated: href } };
      }
      return { error: { code: "unsafe_navigation", message: `blocked navigation to ${String(href)}` } };
    }
    // First pass: let the policy decide.
    const first = await postAction(basePath, req.action, req.payload);
    if (first.needsApproval !== true) return { result: first.result };
    const token = first.approvalToken;
    // Approval required: park the dispatch promise on the user's click,
    // keyed by requestId so concurrent approvals coexist.
    const approved = await new Promise<boolean>((settle) => {
      setPending((prev) => new Map(prev).set(req.requestId, { req, settle }));
    });
    if (!approved) throw new Error("action declined");
    const second = await postAction(basePath, req.action, req.payload, token);
    if (second.needsApproval === true) throw new Error("approval expired — try again");
    return { result: second.result };
  };

  return (
    <div>
      <FlowletStage
        node={node}
        components={[...prewiredComponents, ...components]}
        reactSource={sources.react}
        bundleSource={sources.bundle}
        {...(sources.env ? { env: sources.env } : {})}
        onAction={onAction}
        theme={brandToCssVars(brand)}
        componentTheme={{ theme: mapBrandToTheme(brand), mode: brand.mode ?? "light" }}
      />
      {[...pending.entries()].map(([requestId, entry]) => (
        <div key={requestId} style={{ marginTop: 10 }}>
          <ApprovalCard
            toolName={entry.req.action}
            input={entry.req.payload}
            onApprove={() => settleOne(requestId, true)}
            onDecline={() => settleOne(requestId, false)}
          />
        </div>
      ))}
    </div>
  );
}
