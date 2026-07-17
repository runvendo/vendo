/** Self-scoped audit activity transport (08-ui §3). */
import type { AuditEvent } from "@vendoai/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import type { PollOptions } from "./use-resource.js";

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

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
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
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const generationRef = useRef(0);
  const loadedRef = useRef(false);
  const pollMs = options?.pollMs;

  const refresh = useCallback(async () => {
    const generation = (generationRef.current += 1);
    if (!loadedRef.current) setIsLoading(true);
    try {
      const firstPage = await client.activity.list();
      if (generation !== generationRef.current) return;
      // A refresh reloads the first page rather than appending — pagination
      // continues from the reset head via loadMore.
      setEvents(dedupe(firstPage));
      // An empty first page is already the end; a full one may have more behind
      // the cursor, proven (or disproven) by the next loadMore.
      setHasMore(firstPage.length > 0);
      setError(undefined);
      loadedRef.current = true;
    } catch (reason) {
      if (generation !== generationRef.current) return;
      setError(asError(reason));
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  // Self-scheduling so a slow request can't stack overlapping polls (see
  // use-resource.ts for the rationale).
  useEffect(() => {
    if (pollMs === undefined || pollMs <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollMs, refresh]);

  const loadMore = useCallback(async () => {
    const cursor = pageCursor(events.at(-1));
    const next = await client.activity.list(cursor === undefined ? undefined : { cursor });
    const known = new Set(events.map(event => event.id));
    const added = next.filter(event => !known.has(event.id));
    setEvents(current => dedupe([...current, ...added]));
    // No page, or a page that surfaced nothing new, means there is nothing
    // older left to fetch — we have reached the end of the audit history.
    setHasMore(added.length > 0);
  }, [client, events]);

  return { events, data: events, error, isLoading, hasMore, loadMore, refresh };
}
