"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";

/** The signed-in user's "try this" chip prompts (demo-hygiene). Rides the
 *  thread's string-suggestion tier — pill chips below the scenario cards.
 *  Empty (manifest absent, fetch failed, signed out) means no chip row. */
export function useTryThisChips(): string[] {
  const [chips, setChips] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch(withBasePath("/api/demo/chips"))
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: { chips?: { prompt: string }[] } } | null) => {
        const prompts = (body?.data?.chips ?? []).map((chip) => chip.prompt);
        // An empty manifest keeps the initial [] state — no state write means
        // NO re-render, so the first-visit landing renders exactly once with
        // the scenario cards (the demo-funnel regression contract).
        if (!cancelled && prompts.length > 0) setChips(prompts);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return chips;
}
