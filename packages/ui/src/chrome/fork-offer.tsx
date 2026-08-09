import { encodeGrantPrincipal } from "@vendoai/core";
import { useState } from "react";
import { ChromeRoot } from "./chrome-root.js";

/** The frozen §9.2 encoding lives in core, next to the parser that reads it —
    ONE encoder, so a surface can never write a shape `can()` cannot match.
    Re-exported because the pinned chrome surface names it here. */
export { encodeGrantPrincipal };

export interface ForkOfferProps {
  /** What the person was trying to change, in their words. */
  instruction?: string;
  onFork(): void | PromiseLike<void>;
  onDismiss?(): void;
}

/**
 * Build contract §9.4 — what a VIEWER sees instead of a bare refusal. The
 * `forbidden` code exists precisely so this can be offered: the caller
 * provably sees the app, so "you can't" is answerable with "…but here's what
 * you can do".
 */
export function ForkOffer({ instruction, onFork, onDismiss }: ForkOfferProps) {
  const [busy, setBusy] = useState(false);
  return (
    // The class lives on an INNER div, not on ChromeRoot: a NESTED ChromeRoot
    // returns a bare fragment (chrome-root.tsx), so a container class handed to it
    // silently disappears — which is every mount inside another surface.
    <ChromeRoot>
      <div className="fl-share-fork">
        <p className="fl-share-fork-copy">
          I can’t change the team’s copy{instruction === undefined ? "" : ` to ${instruction}`} — but I can make you your own.
        </p>
        <div className="fl-share-fork-actions">
          <button
            type="button"
            className="fl-btn fl-btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onFork()).finally(() => setBusy(false));
            }}
          >
            Make me my own copy
          </button>
          {onDismiss === undefined ? null : (
            <button type="button" className="fl-btn fl-btn-quiet" onClick={onDismiss}>Never mind</button>
          )}
        </div>
      </div>
    </ChromeRoot>
  );
}
