import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation, type RemixContext } from "./overlay-registry.js";

/**
 * The remixable-surface affordance: the host marking one of its own components
 * as something the user can reshape.
 *
 * At rest a 9px muted ✦ seed sits inside the wrapped element's top-right
 * corner — visible if you look for it, invisible while you are working.
 * Pointing at the element blooms that seed IN PLACE into the ✦ Remix pill —
 * same corner, same optical centre — so it reads as one mark opening rather
 * than a glyph swapping for a button.
 *
 * REVEALED IS STATE, NOT `:hover`. A CSS-only reveal dies the instant the
 * cursor leaves the box, which is exactly what it does on the way to the pill
 * — so the pill could never be clicked. One boolean instead, and pointer-leave
 * only clears it after a grace period the next pointer-enter cancels. Focus
 * reveals it the same way (focus and blur bubble on this div), so it stays
 * keyboard-reachable.
 *
 * IT ATTACHES THE SURFACE, IT DOES NOT TYPE FOR YOU. The pill opens the
 * conversation EMPTY with this surface attached as context (the chip in the
 * panel's chrome), and the ask is typed by the user. Nothing here can fire a
 * turn: opening a composer is not sending a message, so a stray click costs a
 * keystroke, not a model call. The pill is pointer-inert until revealed, so
 * there is nothing invisible to misclick.
 */

/** Long enough for cursor travel from the element to the pill, short enough
 *  that the pill does not linger over the page. */
const GRACE_MS = 200;

export interface RemixableProps {
  /** The surface in the host's own words ("Rent Roll") — the chip's label and
   *  what the agent is told the ask is about. Unlike a `VendoSlot` id this
   *  needs no registration: it is grounding, not a fork target. */
  name: string;
  /** One grounding line about what is on screen, appended after the user's
   *  message — same prop, same meaning as `VendoTrigger`'s `context`. */
  context?: string;
  children: ReactNode;
}

export function Remixable({ name, context, children }: RemixableProps) {
  const [revealed, setRevealed] = useState(false);
  const grace = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(grace.current), []);

  const reveal = () => {
    window.clearTimeout(grace.current);
    setRevealed(true);
  };
  const release = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => setRevealed(false), GRACE_MS);
  };

  const remix: RemixContext = context === undefined ? { name } : { name, context };

  return (
    // data-vendo-remixable marks the element's real boundary, which is also
    // where a pin's ghost flies back into.
    <div
      className="fl-remixable"
      data-vendo-remixable={name}
      {...(revealed ? { "data-vendo-revealed": "" } : {})}
      onPointerEnter={reveal}
      onPointerLeave={release}
      onFocus={reveal}
      onBlur={release}
    >
      {children}
      {/* automaticPolicyNotice={false}: an affordance drawn over the host's own
          markup must never grow the "running without a policy" banner inside
          it — the surface the pill opens carries that warning. */}
      <ChromeRoot className="fl-remixable-chrome" automaticPolicyNotice={false}>
        <span className="fl-remix-seed" aria-hidden="true">✦</span>
        <button
          type="button"
          className="fl-remix-pill"
          aria-label={`Remix ${name} with Vendo`}
          // Blurred on the way out, because the pill is revealed by focus too
          // and a clicked button keeps focus: without this it stays lit on top
          // of whatever the remix produces.
          onClick={event => {
            event.currentTarget.blur();
            const opened = openVendoConversation({ remix });
            if (!opened && developmentMode()) {
              console.warn(`[vendo] Remixable "${name}": the Remix pill opens the conversation surface — mount a VendoOverlay for it to land in.`);
            }
          }}
        >
          <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
          Remix
        </button>
      </ChromeRoot>
    </div>
  );
}
