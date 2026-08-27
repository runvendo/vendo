import type { VendoKnowledgeCitation } from "@vendoai/core";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { themeCssVariables } from "../../theme.js";
import { useChromeTheme } from "../chrome-root.js";
import { sourcesFor } from "./message-data.js";

/** The popover opens 8px below its chip, and that gap belongs to neither: a pure
    CSS :hover card dies in it before the pointer arrives, and no bridge survives
    a diagonal approach (a path that leaves the chip sideways is over nothing at
    all). Hover opens the card from JS and closes it on this grace instead —
    long enough for an unhurried hand to cross, short enough that the card still
    reads as tied to the pointer. Being reachable and dismissible is also what
    WCAG 1.4.13 asks of content shown on hover. */
const GRACE_MS = 260;

/** Room left between a clamped popover and the edge it was clamped against. */
const EDGE_GUTTER = 8;

/** The gap between a chip and its card, on whichever side the card lands. */
const CARD_GAP = 8;

/** Exactly one card is open at a time: whoever opens dismisses the incumbent,
    so travelling along a chip row never stacks two 292px cards on each other. */
let closeOpenCitation: (() => void) | undefined;

/** Knowledge K1 — the origin byline's kind label (mockup: "Product docs"). */
function kindLabel(kind: VendoKnowledgeCitation["kind"]): string {
  if (kind === "glossary") return "Glossary";
  if (kind === "api") return "API reference";
  return "Product docs";
}

const DocIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19a2 2 0 0 1 2-2h13" />
  </svg>
);

/** One citation chip: the bordered pill that expands into the snippet popover
    with the origin byline. Hover opens it and a grace timer closes it (the card
    carries the same enter/leave handlers as the chip, so arriving on it cancels
    the close whatever path the pointer took); a click pins it, so it also
    survives the pointer leaving.

    The card is the one floating surface in the chrome that used to live INSIDE
    the scrolling transcript, where an `overflow: auto` ancestor cropped it and
    a turn's own entrance animation (which leaves a `filter` behind) made it a
    containing block. It portals to <body> like every other floating surface
    here, carrying its own theme boundary. */
function CitationChip({ citation }: { citation: VendoKnowledgeCitation }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const grace = useRef<number | undefined>(undefined);
  const pinned = useRef(false);
  // The card portals out of the ChromeRoot that themes it, so it carries the
  // theme variables itself. The stylesheet is already injected — a citation
  // only ever renders inside a thread, which is inside that same root.
  //
  // It reads THAT root's resolved theme, not the provider's: a thread inside a
  // surface carrying its own `theme` (a dark VendoOverlay on a light page) must
  // not pop a provider-themed hovercard out of it. Outside any boundary this
  // still answers the provider's theme, and the defaults with no provider.
  const theme = useChromeTheme();

  // Stale copies of this closer are harmless — closing a closed chip is a no-op,
  // which is why nothing has to track whose closer is parked in the module slot.
  const close = useCallback(() => {
    window.clearTimeout(grace.current);
    pinned.current = false;
    setOpen(false);
  }, []);

  const show = () => {
    window.clearTimeout(grace.current);
    // Already ours: cancelling the pending close is the whole job. Re-opening
    // would run this chip's own closer and silently drop its pin.
    if (open) return;
    closeOpenCitation?.();
    closeOpenCitation = close;
    setOpen(true);
  };

  const release = () => {
    window.clearTimeout(grace.current);
    if (!pinned.current) grace.current = window.setTimeout(close, GRACE_MS);
  };

  // The card is fixed to the viewport now, so it is placed against the chip's
  // live rect: below it by default, flipped above when it would run off the
  // bottom (the last turn's chips sit right above the composer, so that is the
  // common case), and slid back inside whichever side edge it would cross.
  const place = useCallback(() => {
    if (card.current === null || wrap.current === null) return;
    const chip = wrap.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = card.current;
    const below = chip.bottom + CARD_GAP + height <= window.innerHeight - EDGE_GUTTER;
    card.current.style.top =
      `${below ? chip.bottom + CARD_GAP : Math.max(EDGE_GUTTER, chip.top - CARD_GAP - height)}px`;
    card.current.style.left =
      `${Math.max(EDGE_GUTTER, Math.min(chip.left, window.innerWidth - EDGE_GUTTER - width))}px`;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)
        || !(wrap.current?.contains(event.target) || card.current?.contains(event.target))) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    // Capture, so the TRANSCRIPT's own scrolling reaches this too: a pinned
    // card would otherwise sit where its chip used to be.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place]);

  // A chip unmounted mid-hover must not fire its grace timer into a dead tree.
  useEffect(() => () => window.clearTimeout(grace.current), []);

  // Pre-paint, so the card is never seen at the previous chip's position.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Touch has no hover to intend with, and a tap fires pointerenter before
  // click — it would open the card and then immediately pin it.
  const hover = {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType !== "touch") show();
    },
    onPointerLeave: (event: ReactPointerEvent) => {
      if (event.pointerType !== "touch") release();
    },
  };

  return (
    <span className={`fl-cite${open ? " fl-cite--open" : ""}`} ref={wrap} {...hover}>
      <button
        type="button"
        className="fl-cite-btn"
        aria-expanded={open}
        onClick={() => {
          if (pinned.current) {
            close();
            return;
          }
          show();
          pinned.current = true;
        }}
      >
        <DocIcon />
        {citation.title}
      </button>
      {typeof document === "undefined" ? null : createPortal(
        <span
          className={`vendo-root fl-cite-pop${open ? " fl-cite-pop--open" : ""}`}
          role="note"
          ref={card}
          data-vendo-ignore=""
          // A body child is in `inertBehind`'s blast radius: the overlay panel
          // and the approval modal inert everything that is not theirs, and an
          // inert card keeps its pixels but leaves the hit stack entirely — no
          // wheel, and no pointerenter to cancel the dismiss grace. This says
          // the card belongs above the modal layer, as the toast region does.
          data-vendo-portal="citation"
          style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)" } as CSSProperties}
          {...hover}
        >
          <span className="fl-cite-ptitle"><DocIcon />{citation.title}</span>
          <span className="fl-cite-psnippet">&ldquo;{citation.snippet}&rdquo;</span>
          <span className="fl-cite-porigin">
            {typeof citation.source === "string" && citation.source.length > 0 ? (
              <>
                <span className="fl-cite-psource">{citation.source}</span>
                <span className="fl-cite-sep" aria-hidden="true">·</span>
              </>
            ) : null}
            {kindLabel(citation.kind)}
            <span className="fl-cite-sep" aria-hidden="true">·</span>
            {citation.visibility}
          </span>
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Knowledge K1 — the turn's knowledge trust surface, rendered at the bottom
    of an assistant turn (signed mockups, Surface 2): the labelled SOURCES chip
    row for a grounded answer, the muted searched-line for a structured
    refusal, and the amber flag for an engine outage. All three render from
    the `data-vendo-citations` part's outcome — never from free text. */
export function TurnCitations({ message }: { message: UIMessage }) {
  const { citations, refused, unavailable } = sourcesFor(message);
  if (citations.length === 0 && !refused && !unavailable) return null;
  return (
    <>
      {citations.length > 0 ? (
        <div className="fl-cites" data-vendo-citations="">
          <div className="fl-cites-label">Sources</div>
          <div className="fl-cites-row">
            {citations.map(citation => (
              <CitationChip key={`${citation.docId}::${citation.chunkId ?? ""}`} citation={citation} />
            ))}
          </div>
        </div>
      ) : null}
      {unavailable ? (
        <div className="fl-know-unavail" role="status" data-vendo-knowledge-unavailable="">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18.2v.1" />
          </svg>
          <span>
            I couldn&apos;t check the docs just now, so this isn&apos;t verified against them.
          </span>
        </div>
      ) : null}
      {refused && !unavailable && citations.length === 0 ? (
        <div className="fl-know-searched" data-vendo-knowledge-searched="">
          <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" />
          </svg>
          Searched the docs — no answer for this one
        </div>
      ) : null}
    </>
  );
}
