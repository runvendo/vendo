/** Self-scoped audit activity transport (08-ui §3). */
import type { AuditEvent } from "@vendoai/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useVendoContext } from "../context.js";
import { useResource, type PollOptions } from "./use-resource.js";

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

export function useActivity(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  events: AuditEvent[];
  data: AuditEvent[];
  error: Error | undefined;
  isLoading: boolean;
  /** Whether another page may still exist. Flips to `false` once a fetched page
      is empty or repeats only already-seen rows, so the panel can show a proper
      end-of-list state instead of a "Load more" that fetches nothing new. */
  hasMore: boolean;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.activity.list(), [client]);
  const { data: firstPage, error, isLoading, refresh } = useResource(list, [] as AuditEvent[], options);
  // Pages appended by loadMore; a refresh (manual or poll) reloads the first
  // page rather than appending, so a fresh first page resets pagination and
  // loadMore continues from the reset head.
  const [extra, setExtra] = useState<AuditEvent[]>([]);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    setExtra([]);
    setEnded(false);
  }, [firstPage]);

  const events = useMemo(() => dedupe([...firstPage, ...extra]), [firstPage, extra]);
  // An empty first page is already the end; a full one may have more behind
  // the cursor, proven (or disproven) by the next loadMore.
  const hasMore = !ended && (isLoading || firstPage.length > 0);

  const loadMore = useCallback(async () => {
    const cursor = pageCursor(events.at(-1));
    const next = await client.activity.list(cursor === undefined ? undefined : { cursor });
    const known = new Set(events.map(event => event.id));
    const added = next.filter(event => !known.has(event.id));
    setExtra(current => [...current, ...added]);
    // No page, or a page that surfaced nothing new, means there is nothing
    // older left to fetch — we have reached the end of the audit history.
    setEnded(added.length === 0);
  }, [client, events]);

  return { events, data: events, error, isLoading, hasMore, loadMore, refresh };
}
