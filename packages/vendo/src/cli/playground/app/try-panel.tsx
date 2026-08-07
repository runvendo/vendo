/**
 * The overlay panel's try-mode landing (product-stage shell): the greet
 * headline, the one capability line, and the use-case chips INSIDE the open
 * overlay's empty state — the canvas's `.vx-landing` — without forking the
 * chrome.
 *
 * The chrome seam, deliberately chosen: VendoOverlay's `thread` prop is the
 * one sanctioned component-injection point, so `TryPanelThread` wraps the
 * REAL `VendoThread` and only feeds it content — the landing `greeting`, the
 * additive `intro` capability line, and the chips through the existing
 * `composerAccessory` slot ("rendered directly above the composer"), which is
 * exactly where the canvas places them. A chip press goes through
 * `openVendoConversation({ prompt, send: true })` — the registry's scoped
 * prefill hand-off types the prompt into the panel's REAL composer and
 * submits it, so the send travels the same path in both scripted and live
 * modes (the old DOM-typing autoSend seam retired for chips).
 *
 * Content rides React context (not props) because VendoOverlay remounts its
 * thread whenever the component identity changes: TryPanelThread must be ONE
 * module-level component for the life of the page, while the greet/chips
 * re-derive on every profile store update (the late-seeds chip swap) without
 * ever remounting a conversation in progress.
 */
import { openVendoConversation, VendoThread, type VendoThreadProps } from "@vendoai/ui/chrome";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { UsecaseChip } from "./try-boot.js";

export interface TryPanelContent {
  greeting: string;
  intro: string;
  chips: UsecaseChip[];
}

const TryPanelContext = createContext<TryPanelContent>({ greeting: "", intro: "", chips: [] });

export function TryPanelProvider({ content, children }: { content: TryPanelContent; children: ReactNode }) {
  return <TryPanelContext.Provider value={content}>{children}</TryPanelContext.Provider>;
}

/** The chips row, in the chrome's own chip classes so it re-themes with the
 *  panel. Marked `data-vendo-try-chips` so the page stylesheet can keep it to
 *  the landing (the accessory slot renders in both layouts) and so smoke
 *  probes can find it. */
function PanelChips({ chips }: { chips: UsecaseChip[] }) {
  // The double-send guard: one press fires one send, then every chip goes
  // quiet until the landing leaves (the sent message swaps it away; a fresh
  // conversation remounts this row and re-arms it). The buttons stay real,
  // focusable elements — disabling would drop keyboard focus to the body.
  const [sent, setSent] = useState(false);
  if (chips.length === 0) return null;
  const press = (chip: UsecaseChip): void => {
    if (sent) return;
    setSent(true);
    openVendoConversation({ prompt: chip.prompt, send: true });
  };
  return (
    <div className="fl-chips" data-vendo-try-chips="" role="group" aria-label="Suggestions">
      {chips.map((chip, index) => (
        <button
          key={`${index}:${chip.label}`}
          type="button"
          className="fl-chip"
          aria-disabled={sent}
          onClick={() => press(chip)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/** The overlay's thread, unchanged except for the landing content above. */
export function TryPanelThread(props: VendoThreadProps) {
  const { greeting, intro, chips } = useContext(TryPanelContext);
  return (
    <VendoThread
      {...props}
      greeting={greeting}
      intro={intro}
      composerAccessory={
        <>
          <PanelChips chips={chips} />
          {props.composerAccessory}
        </>
      }
    />
  );
}
