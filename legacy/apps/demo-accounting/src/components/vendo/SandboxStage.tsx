"use client";

/**
 * Provisions the tight sandbox for generated nodes: fetches the React shim +
 * Cadence's merged host bundle (copied into public/vendo/ at build time),
 * wires onAction to the policy-governed action route, and renders the shell's
 * ApprovalCard in-flow when the policy answers "approve" (the ENG-204-approved
 * consent surface — host chrome, never inside the untrusted iframe).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UINode, ActionRequest, ActionResult } from "@vendoai/core";
import { VendoStage } from "@vendoai/react";
import { ApprovalCard } from "@vendoai/shell";
import { prewiredComponents, brandToCssVars, mapBrandToTheme } from "@vendoai/components";
import { cadenceHostComponents } from "@/vendo/host-components/descriptors";
import { cadenceBrand } from "@/vendo/brand";

// Cadence's brand drives the sandbox exactly as it drives the host shell — one
// producer for the --vendo-* vars, one mapping for the OpenUI component theme.
const theme = brandToCssVars(cadenceBrand);
const componentTheme = { theme: mapBrandToTheme(cadenceBrand), mode: cadenceBrand.mode ?? "light" };

interface Sources { react: string; bundle: string }

let sourcesPromise: Promise<Sources> | null = null;
function loadSources(): Promise<Sources> {
  // Module-level memo: fetch once per page, shared by every stage instance.
  if (!sourcesPromise) {
    sourcesPromise = Promise.all([
      fetch("/vendo/react-runtime.js").then((r) => { if (!r.ok) throw new Error("react shim missing"); return r.text(); }),
      fetch("/vendo/components-sandbox.js").then((r) => { if (!r.ok) throw new Error("components bundle missing"); return r.text(); }),
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
  const res = await fetch("/api/vendo/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload, approved }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return { result: json.result };
}

/** The sandbox action consent moment — the SAME ApprovalCard the chat path
 *  uses, materializing in-flow directly beneath the generated view. */
function StageApproval({ req, settle }: { req: ActionRequest; settle: (approved: boolean) => void }) {
  return (
    <div data-testid="stage-approval" className="cadence-approval-inflow" style={{ marginTop: 10 }}>
      <ApprovalCard
        toolName={req.action}
        input={req.payload}
        onApprove={() => settle(true)}
        onDecline={() => settle(false)}
      />
    </div>
  );
}

export function SandboxStage({ node }: { node: UINode }): ReactNode {
  const [sources, setSources] = useState<Sources | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Pending approvals keyed by requestId: CONCURRENT gated dispatches each get
  // their own card (a single slot would orphan the first parked resolver).
  const [pending, setPending] = useState<Map<string, PendingApproval>>(new Map());
  const pendingRef = useRef(pending);
  // Mirror state into the ref post-render (settleOne and the unmount cleanup
  // read it from event/cleanup time, never during render).
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const mounted = useRef(true);
  // Reset on every (re)mount: StrictMode dev runs mount → cleanup → mount, and
  // a cleanup-only effect would leave `mounted` false forever, so the sources
  // `.then` below would never commit and the stage would hang at "loading".
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
      (s) => { if (mounted.current) setSources(s); },
      (e) => { if (mounted.current) setLoadError(String(e.message ?? e)); },
    );
  }, []);

  if (loadError) return <div data-testid="stage-load-error">Sandbox unavailable: {loadError}</div>;
  if (!sources) return <div data-testid="stage-loading" aria-busy="true" />;

  const onAction = async (req: ActionRequest): Promise<ActionResult> => {
    // First pass: let the policy decide.
    const res = await fetch("/api/vendo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: req.action, payload: req.payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
    if (json.needsApproval !== true) return { result: json.result };
    // Approval required: park the dispatch promise on the user's click,
    // keyed by requestId so concurrent approvals coexist.
    const approved = await new Promise<boolean>((settle) => {
      setPending((prev) => new Map(prev).set(req.requestId, { req, settle }));
    });
    if (!approved) throw new Error("action declined");
    return callAction(req.action, req.payload, true);
  };

  return (
    <div>
      <VendoStage
        node={node}
        components={[...prewiredComponents, ...cadenceHostComponents]}
        reactSource={sources.react}
        bundleSource={sources.bundle}
        onAction={onAction}
        theme={theme}
        componentTheme={componentTheme}
      />
      {[...pending.entries()].map(([requestId, entry]) => (
        <StageApproval
          key={requestId}
          req={entry.req}
          settle={(approved) => settleOne(requestId, approved)}
        />
      ))}
    </div>
  );
}
