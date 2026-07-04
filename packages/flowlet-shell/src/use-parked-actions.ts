import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "./context";
import type { ParkedActionRow } from "./components/WaitingList";

const POLL_MS = 30_000;

/** Polls the host's parked-action list (ENG-193 §4.6) every 30s while
 *  mounted; exposes approve/decline that re-fetch immediately after posting. */
export function useParkedActions() {
  const { parkedActions } = useShell();
  const [actions, setActions] = useState<ParkedActionRow[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!parkedActions) return;
    void parkedActions.list().then((rows) => { if (mounted.current) setActions(rows); });
  }, [parkedActions]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    if (!parkedActions) return undefined;
    const id = setInterval(refresh, POLL_MS);
    return () => { mounted.current = false; clearInterval(id); };
  }, [refresh, parkedActions]);

  const approve = (actionId: string) =>
    parkedActions ? parkedActions.resolve(actionId, "yes").then(refresh) : Promise.resolve();
  const decline = (actionId: string) =>
    parkedActions ? parkedActions.resolve(actionId, "no").then(refresh) : Promise.resolve();

  return { actions, count: actions.length, approve, decline, refresh };
}
