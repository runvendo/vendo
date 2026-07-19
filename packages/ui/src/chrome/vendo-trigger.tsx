import type { ReactNode } from "react";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";

export interface VendoTriggerProps {
  /** The prompt preloaded into the conversation composer — prefilled, never
   *  auto-sent, so a trigger is safe even on destructive prompts. */
  prompt: string;
  /** Optional context appended to the prompt (blank-line separated) — the
   *  record or state on screen, so the agent starts oriented. */
  context?: string;
  /** Button label. Default "Ask Vendo". */
  children?: ReactNode;
}

/**
 * The shelf's "do it with AI" button (ui-usage-dx §2): every host affordance
 * that hands a task to the agent is this piece. Activation opens the most
 * recently mounted conversation surface (the VendoOverlay) with the prompt
 * seeded into the composer.
 *
 * Hosts that want their own element as the trigger skip this component and
 * call `openVendoConversation({ prompt })` from it directly — the same
 * programmatic seam this button uses (the repo's idiom; there is deliberately
 * no render-prop API on chrome, ui-usage-dx §4).
 */
export function VendoTrigger({ prompt, context, children }: VendoTriggerProps) {
  return (
    // automaticPolicyNotice={false}: a bare button must never grow the
    // "running without a policy" banner beside itself — the surfaces the
    // trigger opens carry that warning.
    <ChromeRoot automaticPolicyNotice={false}>
      <button
        type="button"
        className="fl-btn"
        style={{ display: "inline-flex", alignItems: "center", gap: "7px" }}
        onClick={() => {
          // Prefill only — never `send`, so a trigger is safe on destructive
          // prompts; the user presses Send themselves.
          const opened = openVendoConversation({ prompt: context ? `${prompt}\n\n${context}` : prompt });
          if (!opened && developmentMode()) {
            console.warn("[vendo] VendoTrigger: no <VendoOverlay /> is mounted to open — this button is a no-op.");
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" />
          <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
        </svg>
        {children ?? "Ask Vendo"}
      </button>
    </ChromeRoot>
  );
}
