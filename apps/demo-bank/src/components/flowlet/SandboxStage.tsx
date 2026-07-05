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

interface ActionResponse {
  result?: unknown;
  needsApproval?: boolean;
  approvalToken?: string;
  error?: string;
}

async function callAction(action: string, payload: unknown, approvalToken?: string): Promise<ActionResponse> {
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload, ...(approvalToken ? { approvalToken } : {}) }),
  });
  const json = (await res.json()) as ActionResponse;
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return json;
}

/**
 * The sandbox action consent moment — the SAME ApprovalCard the chat path uses
 * (ENG-204-approved), materializing in-flow directly beneath the generated
 * view at the trigger point (Yousef's pick, brand-tier review). The card is
 * host chrome: it must never render inside the untrusted iframe.
 */
function StageApproval({ req, settle }: { req: ActionRequest; settle: (approved: boolean) => void }) {
  return (
    <div data-testid="stage-approval" className="maple-approval-inflow" style={{ marginTop: 10 }}>
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
  // their own card (a single slot would orphan the first parked resolver —
  // review finding). settleOne is idempotent per id.
  const [pending, setPending] = useState<Map<string, PendingApproval>>(new Map());
  const pendingRef = useRef(pending);
  const mounted = useRef(true);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // Reset on every (re)mount: StrictMode dev runs mount → cleanup → mount, and
  // a cleanup-only effect would leave `mounted` false forever, so the sources
  // `.then` below would never commit and the stage would hang at "loading".
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Unmounting with approvals parked: settle them all as declined so the
      // host-side dispatch promises never leak (review finding).
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
    // First pass: let the policy decide. An "approve" answer carries a
    // single-use token bound to this exact (action, payload) — the re-POST
    // must present it (the old trusted `approved:true` re-POST is gone).
    const first = await callAction(req.action, req.payload);
    if (first.needsApproval !== true) return { result: first.result };
    // Approval required: park the dispatch promise on the user's click,
    // keyed by requestId so concurrent approvals coexist.
    const approved = await new Promise<boolean>((settle) => {
      setPending((prev) => new Map(prev).set(req.requestId, { req, settle }));
    });
    if (!approved) throw new Error("action declined");
    const second = await callAction(req.action, req.payload, first.approvalToken);
    if (second.needsApproval === true) throw new Error("approval expired — try again");
    return { result: second.result };
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
