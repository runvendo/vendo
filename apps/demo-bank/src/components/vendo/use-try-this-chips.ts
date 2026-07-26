"use client";

import { useEffect, useState } from "react";

/** The signed-in user's "try this" chip prompts (demo-hygiene). Rides the
 *  thread's string-suggestion tier — pill chips below the scenario cards.
 *  Empty (manifest absent, fetch failed, signed out) means no chip row. */
export function useTryThisChips(): string[] {
  const [chips, setChips] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/demo/chips")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: { chips?: { prompt: string }[] } } | null) => {
        if (!cancelled) setChips((body?.data?.chips ?? []).map((chip) => chip.prompt));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return chips;
}
