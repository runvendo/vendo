"use client";
/**
 * The Vendo pane frames the generated app in a HOST DOCUMENT: an iframe onto
 * this app's own `/embed/<host>?run=<id>` route, which boots the production
 * runtime (VendoProvider → AppFrame → Kit + the host's registry) inside a
 * document whose only stylesheet is the demo host's real `globals.css`. The
 * app therefore renders with Maple's/Cadence's brand tokens, Tailwind
 * preflight and utilities — the same CSS context examples/demo-bank gives a
 * generated app — while the cockpit's hand-rolled dark chrome stays
 * untouchable on the other side of the frame boundary.
 *
 * Why a document and not a scoped layer or a shadow root:
 *  - Scoped layer (Tailwind compiled into the cockpit page under a container
 *    class): Tailwind v4 emits `@theme` tokens on `:root`, and Maple and
 *    Cadence define the SAME token names (`--color-surface`, `--color-ink`)
 *    with different values. Coexisting in one document means selector-
 *    rewriting each host's compiled sheet — a generated artifact that drifts
 *    from the host — and preflight (`*`, `html`, `body`) would still be one
 *    stray rule away from stomping the cockpit.
 *  - Shadow DOM: `:root`-scoped tokens and preflight's element selectors do
 *    not apply inside a shadow root without rewriting the sheet, and portalled
 *    UI escapes the root and loses its styles.
 *  - Iframe with React portalled in from this realm: rejected because it
 *    BREAKS the island jail (packages/ui/src/tree/jail). The jail's relay
 *    frame posts to `parent` — the window owning the frame's document — while
 *    JailedComponent's `window.addEventListener("message")` binds the realm
 *    the React code runs in. Portalling splits those two, so jailed islands
 *    would never render. `/embed/<host>` avoids it by booting its own React
 *    realm inside the frame, so both sides are the frame's window again.
 *
 * The frame is same-origin, so the runtime's tool transport still POSTs
 * straight to /api/tools (no cross-frame plumbing), and split-compare is just
 * two frames in read-only mode.
 */
import type { LaneResult } from "../runner/types";
import type { PaneProps } from "./pane-props";

const FRAME_STYLE: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  minHeight: 0,
  border: 0,
  background: "transparent",
};
const COMPARE_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  gap: 1,
  minWidth: 0,
  height: "100%",
};

function PaneNote({ children }: { children: React.ReactNode }) {
  return (
    <div data-vendo-pane-note="" style={{ padding: 12, fontSize: 13, opacity: 0.75 }}>
      {children}
    </div>
  );
}

function HostFrame({
  host,
  runId,
  readOnly,
  title,
}: {
  host: string;
  runId: string;
  readOnly: boolean;
  title: string;
}) {
  return (
    <iframe
      data-vendo-host-frame={host}
      title={title}
      src={`/embed/${host}?run=${encodeURIComponent(runId)}${readOnly ? "&mode=readonly" : ""}`}
      style={FRAME_STYLE}
    />
  );
}

/** A lane result is frameable only when it carries a document to render. */
function hasDocument(result: LaneResult | undefined): boolean {
  return result?.status === "ok" && result.document !== undefined;
}

export function VendoPane({ result, host, runId, compare }: PaneProps) {
  if (result.status === "no-key") {
    return <PaneNote>No model key — set ANTHROPIC_API_KEY in the repo-root .env.</PaneNote>;
  }
  if (result.status === "failed") {
    return <PaneNote>Generation failed: {result.error}</PaneNote>;
  }
  if (!hasDocument(result)) {
    return <PaneNote>The run carries no document.</PaneNote>;
  }

  if (compare !== undefined) {
    return (
      <div data-vendo-pane-compare="" style={COMPARE_GRID}>
        {/* minWidth:0 on the tracks is what keeps a wide generated app inside
            its half — grid tracks default to min-content and would otherwise
            spill the compared document across the neighbouring panes. */}
        <HostFrame host={host} runId={runId} readOnly title="Vendo — current run" />
        {hasDocument(compare.result) ? (
          <HostFrame host={host} runId={compare.runId} readOnly title="Vendo — compared run" />
        ) : (
          <PaneNote>The compared run carries no document.</PaneNote>
        )}
      </div>
    );
  }
  return <HostFrame host={host} runId={runId} readOnly={false} title="Vendo — generated app" />;
}

export default VendoPane;
