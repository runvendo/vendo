/**
 * Provisions the tight sandbox for generated nodes: fetches the React shim +
 * the app's merged host bundle (copied into public/flowlet/ at predev), wires
 * onAction to the policy-governed action route, and renders the shell's
 * ApprovalCard in-flow beneath the view for gated actions (the ENG-204/184
 * approved consent surface — host chrome, never inside the untrusted iframe).
 *
 * Approval handshake, hardened per this demo's action route: an `approve`
 * decision returns { needsApproval, approvalToken }; consenting re-POSTs the
 * SAME action+payload with that one-time token. No token, no execution.
 */
import React, { useEffect, useRef, useState } from "react";
import { FlowletStage } from "@flowlet/react";
import { ApprovalCard } from "@flowlet/shell";
import {
  prewiredComponents,
  brandToCssVars,
  mapBrandToTheme,
  brandTokensSchema,
} from "@flowlet/components";
import { gmailHostComponents } from "./host-components";
import brandJson from "./brand.json";

const brand = brandTokensSchema.parse(brandJson);
const theme = brandToCssVars(brand);
const componentTheme = { theme: mapBrandToTheme(brand), mode: brand.mode ?? "light" };
const registry = [...prewiredComponents, ...gmailHostComponents];

let sourcesPromise = null;
function loadSources() {
  // Module-level memo: fetch once per page, shared by every stage instance.
  if (!sourcesPromise) {
    sourcesPromise = Promise.all([
      fetch("/flowlet/react-runtime.js").then((r) => {
        if (!r.ok) throw new Error("react shim missing");
        return r.text();
      }),
      fetch("/flowlet/components-sandbox.js").then((r) => {
        if (!r.ok) throw new Error("components bundle missing");
        return r.text();
      }),
    ]).then(([react, bundle]) => ({ react, bundle }));
    sourcesPromise.catch(() => {
      sourcesPromise = null; // allow retry on failure
    });
  }
  return sourcesPromise;
}

async function postAction(payload) {
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return json;
}

function StageApproval({ req, settle }) {
  return (
    <div data-testid="stage-approval" style={{ marginTop: 10 }}>
      <ApprovalCard
        toolName={req.action}
        input={req.payload}
        onApprove={() => settle(true)}
        onDecline={() => settle(false)}
      />
    </div>
  );
}

export function SandboxStage({ node }) {
  const [sources, setSources] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Pending approvals keyed by requestId: concurrent gated dispatches each get
  // their own card; settleOne is idempotent per id.
  const [pending, setPending] = useState(new Map());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const mounted = useRef(true);
  // Resolvers are also tracked in a plain ref written SYNCHRONOUSLY at dispatch
  // time (before React commits `pending`), so an unmount racing the state
  // commit still settles the parked promise instead of leaking it (review).
  const resolversRef = useRef(new Map());

  // Reset on every (re)mount: StrictMode dev runs mount → cleanup → mount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Unmounting with approvals parked: settle as declined so the host-side
      // dispatch promises never leak.
      for (const settle of resolversRef.current.values()) settle(false);
      resolversRef.current.clear();
    };
  }, []);

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

  const settleOne = (requestId, approved) => {
    const settle = resolversRef.current.get(requestId);
    if (!settle) return; // idempotent: already settled/removed
    resolversRef.current.delete(requestId);
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
    settle(approved);
  };

  const onAction = async (req) => {
    // First pass: let the policy decide.
    const first = await postAction({ action: req.action, payload: req.payload });
    if (first.needsApproval !== true) return { result: first.result };
    // Approval required. The server enriches the payload with the EXACT content
    // this approval covers (drafted reply body, Slack line, sender/subject) and
    // binds the token to it — show and re-POST that enriched payload, so the
    // user approves precisely what will run.
    const payload = first.payload ?? req.payload;
    const approved = await new Promise((settle) => {
      // Register the resolver synchronously (survives an unmount before commit),
      // then render the card.
      resolversRef.current.set(req.requestId, settle);
      setPending((prev) =>
        new Map(prev).set(req.requestId, { req: { action: req.action, payload } }),
      );
    });
    if (!approved) throw new Error("action declined");
    const second = await postAction({
      action: req.action,
      payload,
      approvalToken: first.approvalToken,
    });
    return { result: second.result };
  };

  return (
    <div>
      <FlowletStage
        node={node}
        components={registry}
        reactSource={sources.react}
        bundleSource={sources.bundle}
        onAction={onAction}
        theme={theme}
        componentTheme={componentTheme}
      />
      {[...pending.entries()].map(([requestId, entry]) => (
        <StageApproval key={requestId} req={entry.req} settle={(ok) => settleOne(requestId, ok)} />
      ))}
    </div>
  );
}
