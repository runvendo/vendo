"use client";

import { useEffect, useRef, useState } from "react";
import type { DemoBeat } from "@/lib/demo-config";

// ============================================================================
// PLUMBING — DO NOT REWRITE PER PROSPECT (edit demo.config.json's `beats`
// instead; this strip renders whatever the config says).
//
// SEAM NOTE — why these chips copy instead of submitting: VendoThread's only
// official composer seam is its `suggestions?: string[]` prop, which renders
// chips on the EMPTY landing and sends the clicked string verbatim (the demo
// panel wires `beats[].prompt` through it, so first-turn chips DO submit).
// There is no @vendoai/ui seam to prefill or submit the composer mid-thread
// from outside — useVendoThread instances don't share chat state — and DOM
// hacks against the composer are forbidden here. So this persistent strip
// shows `beats[].chip` labels and, on click, reveals the beat's full prompt
// with a copy affordance. If packages/ui grows a labeled-suggestion or
// composer-prefill seam, replace the copy fallback with it.
// ============================================================================

/** How long the "Copied" confirmation lingers on the copy button. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * The demo.config beats as a persistent chip strip above the thread. Clicking
 * a chip reveals the beat's full prompt with a copy button so a visitor can
 * paste it into the composer at any point in the conversation.
 */
export function SuggestionChips({ beats }: { beats: DemoBeat[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  if (beats.length === 0) return null;
  const open = beats.find((beat) => beat.key === openKey);

  const copyPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Clipboard unavailable — the prompt is already revealed for manual selection.
    }
  };

  return (
    <div className="border-b bg-surface px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Try:</span>
        {beats.map((beat) => (
          <button
            key={beat.key}
            type="button"
            aria-expanded={openKey === beat.key}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              openKey === beat.key ? "bg-ink text-surface" : "text-ink hover:bg-bg"
            }`}
            onClick={() => {
              setOpenKey((key) => (key === beat.key ? null : beat.key));
              setCopied(false);
            }}
          >
            {beat.chip}
          </button>
        ))}
      </div>
      {open !== undefined ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-bg px-3 py-2">
          <span className="text-sm text-ink">{open.prompt}</span>
          <button
            type="button"
            className="rounded-full border bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-bg"
            onClick={() => void copyPrompt(open.prompt)}
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
