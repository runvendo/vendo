"use client";

/**
 * Provisions the tight sandbox for generated nodes: fetches the React shim +
 * components host bundle (copied into public/flowlet/ at build time), wires
 * onAction to the policy-governed action route, and renders an inline approval
 * prompt when the policy answers "approve".
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UINode, ActionRequest, ActionResult } from "@flowlet/core";
import { FlowletStage } from "@flowlet/react";
import { ApprovalCard } from "@flowlet/shell";
import { prewiredComponents, brandToCssVars, mapBrandToTheme } from "@flowlet/components";
import { mapleHostComponents } from "@/flowlet/host-components/descriptors";
import { mapleBrand } from "@/flowlet/brand";

// Maple's brand drives the sandbox exactly as it drives the host shell — one
// producer for the --flowlet-* vars, one mapping for the OpenUI component theme.
const theme = brandToCssVars(mapleBrand);
const componentTheme = { theme: mapBrandToTheme(mapleBrand), mode: mapleBrand.mode ?? "light" };

interface Sources { react: string; bundle: string }
let sourcesPromise: Promise<Sources> | null = null;
function loadSources(): Promise<Sources> {
  // Module-level memo: fetch once per page, shared by every stage instance.
  if (!sourcesPromise) {
    sourcesPromise = Promise.all([
      fetch("/flowlet/react-runtime.js").then((r) => { if (!r.ok) throw new Error("react shim missing"); return r.text(); }),
      fetch("/flowlet/components-sandbox.js").then((r) => { if (!r.ok) throw new Error("components bundle missing"); return r.text(); }),
    ]).then(([react, bundle]) => ({ react, bundle }));
    sourcesPromise.catch(() => { sourcesPromise = null; }); // allow retry on failure
  }
  return sourcesPromise;
}

interface PendingApproval {
  req: ActionRequest;
  settle: (approved: boolean) => void;
}

async function callAction(action: string, payload: unknown, approved: boolean): Promise<ActionResult> {
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload, approved }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return { result: json.result };
}

/** Review scaffolding (brand-tier treatment pick): "card" | "modal" | "sheet".
 *  Collapses to the chosen treatment once Yousef picks. Default: card. */
function approvalTreatment(): string {
  try {
    return window.localStorage.getItem("flowlet-approval-treatment") ?? "card";
  } catch {
    return "card";
  }
}

/**
 * The sandbox action consent moment — the SAME ApprovalCard the chat path uses
 * (ENG-204, Yousef-approved), replacing the demo-era yellow inline prompt.
 * The card is host chrome: it must never render inside the untrusted iframe.
 */
function StageApproval({ req, settle }: { req: ActionRequest; settle: (approved: boolean) => void }) {
  const treatment = approvalTreatment();
  const card = (
    <ApprovalCard
      toolName={req.action}
      input={req.payload}
      onApprove={() => settle(true)}
      onDecline={() => settle(false)}
    />
  );

  if (treatment === "modal") {
    return (
      <div
        data-testid="stage-approval"
        role="dialog"
        aria-modal="true"
        aria-label="Approve action"
        onClick={(e) => { if (e.target === e.currentTarget) settle(false); }}
        style={{
          position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center",
          background: "color-mix(in srgb, var(--flowlet-fg, #111) 24%, transparent)",
          backdropFilter: "blur(2.5px)", WebkitBackdropFilter: "blur(2.5px)",
        }}
      >
        <div className="maple-approval-pop" style={{ minWidth: "min(420px, 92vw)" }}>{card}</div>
      </div>
    );
  }

  if (treatment === "sheet") {
    return (
      <div data-testid="stage-approval" className="maple-approval-sheet" style={{ marginTop: 10 }}>
        {card}
      </div>
    );
  }

  // "card" (default): the approved card in-flow, directly beneath the view.
  return (
    <div data-testid="stage-approval" className="maple-approval-inflow" style={{ marginTop: 10 }}>
      {card}
    </div>
  );
}

export function SandboxStage({ node }: { node: UINode }): ReactNode {
  const [sources, setSources] = useState<Sources | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const mounted = useRef(true);
  // Reset on every (re)mount: StrictMode dev runs mount → cleanup → mount, and
  // a cleanup-only effect would leave `mounted` false forever, so the sources
  // `.then` below would never commit and the stage would hang at "loading".
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    loadSources().then(
      (s) => { if (mounted.current) setSources(s); },
      (e) => { if (mounted.current) setLoadError(String(e.message ?? e)); },
    );
  }, []);

  if (loadError) return <div data-testid="stage-load-error">Sandbox unavailable: {loadError}</div>;
  if (!sources) return <div data-testid="stage-loading" aria-busy="true" />;

  const onAction = async (req: ActionRequest): Promise<ActionResult> => {
    // First pass: let the policy decide.
    const res = await fetch("/api/flowlet/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: req.action, payload: req.payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
    if (json.needsApproval !== true) return { result: json.result };
    // Approval required: park the dispatch promise on the user's click.
    const approved = await new Promise<boolean>((settle) => setPending({ req, settle }));
    setPending(null);
    if (!approved) throw new Error("action declined");
    return callAction(req.action, req.payload, true);
  };

  return (
    <div>
      <FlowletStage
        node={node}
        components={[...prewiredComponents, ...mapleHostComponents]}
        reactSource={sources.react}
        bundleSource={sources.bundle}
        onAction={onAction}
        theme={theme}
        componentTheme={componentTheme}
      />
      {pending && <StageApproval req={pending.req} settle={pending.settle} />}
    </div>
  );
}
