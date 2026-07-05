"use client";

/**
 * Client-side detector tick. Polls the Vendo poll endpoint on an interval and
 * forwards any fire events to the host. Polling Maple's existing data (server
 * side) is how the drop-in layer detects the late-night order without touching
 * the bank.
 */
import { useEffect, useRef } from "react";

export interface FireEvent {
  txnId: string;
  merchant: string;
  amountDollars: number;
  time: string;
  channel: string;
  description: string;
  slack: { ok: boolean; fallback: boolean };
}

export function VendoPoller({
  onFire,
  intervalMs = 2000,
}: {
  onFire: (e: FireEvent) => void;
  intervalMs?: number;
}) {
  const onFireRef = useRef(onFire);

  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/vendo/poll", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { events?: FireEvent[] } };
        const events = json.data?.events ?? [];
        if (stopped) return;
        for (const e of events) onFireRef.current(e);
      } catch {
        /* transient — next tick retries */
      }
    };
    const id = setInterval(tick, intervalMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return null;
}
