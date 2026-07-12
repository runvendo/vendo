/** Self-scoped audit activity transport (08-ui §3). */
import type { AuditEvent } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";

function dedupe(events: AuditEvent[]): AuditEvent[] {
  const seen = new Set<string>();
  return events.filter(event => !seen.has(event.id) && seen.add(event.id));
}

export function useActivity(): { events: AuditEvent[]; loadMore(): Promise<void> } {
  const { client } = useVendoContext();
  const [events, setEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    let active = true;
    void client.activity
      .list()
      .then(firstPage => {
        if (active) setEvents(dedupe(firstPage));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  const loadMore = useCallback(async () => {
    const cursor = events.at(-1)?.id;
    const next = await client.activity.list(cursor === undefined ? undefined : { cursor });
    setEvents(current => dedupe([...current, ...next]));
  }, [client, events]);

  return { events, loadMore };
}
