/**
 * `useToolAction` — the write, in code-land (blueprint §5.4).
 *
 * The same door as the read (`POST /apps/:appId/call`), the same guard-bound
 * caller, the same `ToolOutcome`. Every mount site in this repo already shapes
 * an action as one line —
 * `onAction={({action, payload}) => client.apps.call(appId, action, payload ?? {})}`
 * — and this is that line for code.
 *
 * Two laws it carries so the app author never has to:
 *   - a non-ok outcome is a CONTAINED notice, never a crash (the renderer's
 *     `runAction`, ui/tree/renderer.tsx);
 *   - a SUCCESSFUL action refreshes the screen's queries (§6.3 law 2).
 */

import type { Json, ToolOutcome } from "@vendoai/core";
import { useCallback, useState } from "react";
import { useVendoApp } from "./app-context.js";

export interface ToolAction {
  /** Run it. Resolves with the outcome; never throws. */
  run(args?: Json): Promise<ToolOutcome>;
  /** A run is in flight (its query refresh included). */
  pending: boolean;
  /** The last NON-OK outcome, for the contained notice — `blocked` says why,
   *  `pending-approval` and `connect-required` carry their own affordance. A
   *  success clears it. */
  outcome: ToolOutcome | undefined;
}

export function useToolAction(ref: string): ToolAction {
  const { call, refetchQueries } = useVendoApp();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ToolOutcome | undefined>(undefined);

  const run = useCallback(async (args: Json = {}): Promise<ToolOutcome> => {
    setPending(true);
    try {
      const result = await call(ref, args);
      setOutcome(result.status === "ok" ? undefined : result);
      // Only a success changes what the screen's reads would answer; a refusal
      // left the world exactly as it was, so re-reading it would be noise.
      if (result.status === "ok") await refetchQueries();
      return result;
    } finally {
      setPending(false);
    }
  }, [call, ref, refetchQueries]);

  return { run, pending, outcome };
}
