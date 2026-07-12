/** Self-scoped audit activity transport (08-ui §3). */
import type { AuditEvent } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";

function dedupe(events: AuditEvent[]): AuditEvent[] {
  const seen = new Set<string>();
  return events.filter(event => !seen.has(event.id) && seen.add(event.id));
}

/** The store pages audit rows on `(at, id)` behind an opaque base64url `{c,i}`
    cursor. `/activity` returns a bare `AuditEvent[]` (09 §3), so the client
    reconstructs that cursor from the oldest event it holds to fetch the next
    page — the raw event id alone is not a decodable cursor. */
function pageCursor(event: AuditEvent | undefined): string | undefined {
  if (event === undefined) return undefined;
  const json = JSON.stringify({ c: event.at, i: event.id });
  const base64 = typeof btoa === "function"
    ? btoa(json)
    : Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    const cursor = pageCursor(events.at(-1));
    const next = await client.activity.list(cursor === undefined ? undefined : { cursor });
    setEvents(current => dedupe([...current, ...next]));
  }, [client, events]);

  return { events, loadMore };
}
