/**
 * ONE placement poller per client, shared by every mounted slot.
 *
 * Slot discovery used to be per-slot: each `VendoSlot` listed EVERY app the
 * person owned, every 5s, and scanned the documents for its own name. Three
 * slots on a page meant three full app lists a tick. This inverts it — slots
 * register their id, the poller asks for all of them in one
 * `GET /apps/placements?slots=…`, and every listener is woken with the answer.
 *
 * Module scope keyed by the client (like the overlay/palette registries): the
 * slots sharing a poller share no React tree, and the client IS the identity
 * of a deployment's wire. Nothing polls until a slot registers, and the loop
 * stops with the last one — SSR renders start nothing.
 *
 * The same per-client scope carries the OUTBOUND half (`report`): a page of
 * slots telling the registry they exist, deduped and batched into one write.
 */
import {
  log,
  SLOTS_REPORT_MAX,
  SLOT_DESCRIPTION_MAX_CHARS,
  SLOT_ID_MAX_CHARS,
  SLOT_LABEL_MAX_CHARS,
  SLOT_REPORT_REFRESH_MS,
} from "@vendoai/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { developmentMode } from "../chrome/dev-mode.js";
import type { VendoClient } from "../client.js";
// `useVendoProvider`, NOT `useVendoContext`: #852 renamed the provider-reading
// hook and gave the old name to the host-facing `useVendoContext(data)` in
// hooks/use-vendo-context.ts, which publishes into the agent's [Situation]
// channel and returns void.
import { useVendoProvider } from "../context.js";
import { identityState } from "./identity-state.js";
import { onPinAnnounced } from "../pin-events.js";
import type { PlacementEntry } from "../wire-types.js";

/** The floor under the pin bus: a placement made anywhere else (another tab,
 *  an agent turn, a build that just landed) shows up within this. */
const POLL_MS = 5000;
/** The pin ceremony's ghost lands at ~480ms; re-read as it does. */
const PIN_SETTLE_MS = 500;

export interface SlotPlacement {
  /** The placement in this slot, or undefined when the slot is empty. */
  entry: PlacementEntry | undefined;
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
}

interface Poller {
  add(slot: string, listener: () => void): () => void;
  entry(slot: string): PlacementEntry | undefined;
  error(): Error | undefined;
  loading(): boolean;
  refresh(): Promise<void>;
  report(slot: string, label: string, description?: string): void;
}

/** One slot, as a page reports it. */
interface Reported {
  id: string;
  label: string;
  description?: string;
}

const pollers = new WeakMap<VendoClient, Poller>();

function createPoller(client: VendoClient): Poller {
  const listeners = new Map<string, Set<() => void>>();
  const settles = new Set<ReturnType<typeof setTimeout>>();
  // H2-E / #1372: while the wire says forbidden, the tick skips both the read
  // AND renew's slot-report writes — a signed-out visitor generates zero
  // traffic. The latch opening (identity signal, or any surface's successful
  // read) re-reads immediately.
  const identity = identityState(client);
  let entries = new Map<string, PlacementEntry>();
  let error: Error | undefined;
  let loaded = false;
  let running = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopPin: (() => void) | undefined;
  let stopIdentity: (() => void) | undefined;

  /** Every (id, label) pair already sent to the registry, and WHEN — once per
   *  client per {@link SLOT_REPORT_REFRESH_MS}, so a page of slots re-rendering
   *  all day writes nothing after the first tick, but a client that outlives the
   *  registry's decay window renews its slots instead of watching them age out
   *  from under a surface that is still mounting them. A host that mints a
   *  client per page (Maple does) starts a fresh map on every one, so SPA
   *  back-navigation re-reports a slot; the write is idempotent, so that costs
   *  one request and changes nothing. */
  const reported = new Map<string, number>();
  let queued: Reported[] = [];
  let flushing = false;

  // The whole entry, not a tuple: `JSON.stringify` writes an absent array slot
  // as `null`, so a tuple key parses back with `description: null` and the
  // renewal below re-reports garbage. An omitted object key just stays omitted.
  const keyOf = (entry: Reported): string => JSON.stringify(entry);
  /** Un-remember entries that never reached the registry. `reported` is keyed by
   *  the CLIENT and outlives the React tree, so a key left behind here silences
   *  that slot until the refresh window — which is what the source used to promise
   *  it did not do ("another chance from the next page that mounts it"). */
  const forget = (entries: readonly Reported[]): void => {
    for (const entry of entries) reported.delete(keyOf(entry));
  };

  const announce = (): void => {
    for (const set of [...listeners.values()]) for (const listener of [...set]) listener();
  };

  /** A generation guard, like useResource's: overlapping reads (poll + pin +
   *  a slot mounting) must never let an older answer land on a newer one. */
  const read = async (): Promise<void> => {
    const slots = [...listeners.keys()];
    if (slots.length === 0) return;
    const mine = (generation += 1);
    try {
      const answered = await client.apps.placements(slots);
      if (mine !== generation) return;
      identity.clear();
      entries = new Map(answered.map(item => [item.slot, item]));
      error = undefined;
    } catch (reason) {
      if (mine !== generation) return;
      identity.note(reason);
      error = reason instanceof Error ? reason : new Error(String(reason));
    }
    loaded = true;
    announce();
  };

  /** Keep the registry's rows alive under a client that never re-mounts them.
   *  `useReportSlot` fires on mount and on a changed prop, so a slot rendered
   *  by a tab left open for weeks would never report again and would age out of
   *  the registry while it is still on the screen. The poll loop runs for
   *  exactly as long as a slot is mounted, so it carries the renewal. */
  const renew = (): void => {
    const stale = Date.now() - SLOT_REPORT_REFRESH_MS;
    for (const [key, at] of [...reported]) {
      if (at > stale) continue;
      const { id, label, description } = JSON.parse(key) as Reported;
      if (listeners.has(id)) poller.report(id, label, description);
    }
  };

  /** The held queue's OWN wake, independent of the poller lifecycle (greptile
   *  on #1442, round three): a useReportSlot-only mount never calls start(),
   *  so no other subscription exists to flush what it held. Lazy — created
   *  only when something is actually held — and self-disposing on the first
   *  open transition, so a signed-in page carries no extra listener. It
   *  deliberately survives stop(): it belongs to the queue, not to the
   *  placement listeners (round two's stranding was scoping it wrong). */
  let stopHeldFlush: (() => void) | undefined;
  const ensureHeldFlush = (): void => {
    if (stopHeldFlush !== undefined) return;
    stopHeldFlush = identity.subscribe(() => {
      if (identity.forbidden()) return;
      stopHeldFlush?.();
      stopHeldFlush = undefined;
      flushReports();
    });
  };

  /** Send everything queued, batched and capped. Latched-forbidden holds the
   *  queue in place — a microtask committed before the latch closed must not
   *  slip a write out either. The stamp is written HERE, at send time: an
   *  entry that never went out carries no stamp, so nothing held can silence
   *  its own slot's next mount (overflow needs no forget() for the same
   *  reason — never stamped, reported by the next page that mounts it). */
  const flushReports = (): void => {
    flushing = false;
    if (identity.forbidden()) {
      if (queued.length > 0) ensureHeldFlush();
      return;
    }
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    const sending = batch.slice(0, SLOTS_REPORT_MAX);
    if (sending.length < batch.length && developmentMode()) {
      log({
        code: "ui.slots-report-overflow",
        level: "warn",
        message: `[vendo] a page may report at most ${SLOTS_REPORT_MAX} slots at once — ${batch.length - sending.length} were held back for a later render.`,
      });
    }
    const now = Date.now();
    for (const entry of sending) reported.set(keyOf(entry), now);
    void client.slots.report(sending).catch(() => forget(sending));
  };

  // Self-scheduling, never setInterval: the next tick is armed only once the
  // current read settles, so a slow wire cannot stack overlapping requests.
  const tick = async (): Promise<void> => {
    if (!identity.forbidden()) {
      renew();
      await read();
    }
    if (running) timer = setTimeout(() => void tick(), POLL_MS);
  };

  const start = (): void => {
    if (running) return;
    running = true;
    stopIdentity = identity.subscribe(() => {
      if (running && !identity.forbidden()) {
        void read();
        flushReports();
      }
    });
    stopPin = onPinAnnounced(() => {
      void read();
      const settle = setTimeout(() => {
        settles.delete(settle);
        void read();
      }, PIN_SETTLE_MS);
      settles.add(settle);
    });
    // The FIRST read waits a microtask: every slot mounting in the same React
    // commit registers before it fires, so a page of slots opens with one
    // request instead of one per slot as each effect runs.
    queueMicrotask(() => {
      if (running) void tick();
    });
  };

  const stop = (): void => {
    running = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stopPin?.();
    stopPin = undefined;
    stopIdentity?.();
    stopIdentity = undefined;
    for (const settle of settles) clearTimeout(settle);
    settles.clear();
    generation += 1;
    entries = new Map();
    error = undefined;
    loaded = false;
  };

  const poller: Poller = {
    add(slot, listener) {
      const set = listeners.get(slot) ?? new Set<() => void>();
      const first = set.size === 0;
      set.add(listener);
      listeners.set(slot, set);
      if (!running) start();
      // A slot mounted later must not wait out a poll tick for its first answer.
      else if (first) void read();
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(slot);
        if (listeners.size === 0) stop();
      };
    },
    entry: slot => entries.get(slot),
    error: () => error,
    loading: () => !loaded,
    refresh: read,
    report(slot, label, description) {
      // The route validates the batch ALL-OR-NOTHING, and a page reports every
      // slot it mounts in one batch, so a single over-long host prop would take
      // the whole page out of the "Add to…" picker. The client cleans its own
      // report to fit instead; the route stays the strict backstop.
      if (slot.length === 0 || slot.length > SLOT_ID_MAX_CHARS) {
        if (developmentMode()) {
          log({
            code: "ui.vendo-slot-id-invalid",
            level: "warn",
            message: `[vendo] VendoSlot id must be 1-${SLOT_ID_MAX_CHARS} characters — this slot is not reported, so nothing can offer it as a destination.`,
          });
        }
        return;
      }
      // Clamped, not skipped: a verbose label is still a real destination, and
      // so is a slot whose developer wrote a paragraph of intent.
      const entry: Reported = {
        id: slot,
        label: label.slice(0, SLOT_LABEL_MAX_CHARS),
        // An empty string is left off entirely: the route reads a description
        // as a NON-EMPTY string and refuses the whole batch over one, so a
        // `description=""` on one slot would unregister the entire page.
        ...(description === undefined || description.length === 0
          ? {}
          : { description: description.slice(0, SLOT_DESCRIPTION_MAX_CHARS) }),
      };
      // JSON, not a separator join: a space (or any other delimiter) is legal
      // in every half, so `${slot} ${label}` merges ("sales report", "Q3")
      // with ("sales", "report Q3") and the second slot never reaches the
      // registry — it is a destination the picker can never offer.
      const key = keyOf(entry);
      // The stamp belongs to a report that actually went out (flushReports
      // sets it at send time; the send-failure path forgets it for the same
      // reason). Stamping at queue time stranded a HELD report: a slot that
      // mounted latched, unmounted, and remounted after sign-in read its own
      // stale stamp and stayed silent for the whole refresh window (greptile
      // on #1442, round two). A held duplicate is deduped against the queue
      // itself — and the flush still re-arms, so a remount is what finally
      // sends a queue the torn-down identity subscription left behind.
      const at = reported.get(key);
      if (at !== undefined && Date.now() - at < SLOT_REPORT_REFRESH_MS) return;
      if (!queued.some(item => keyOf(item) === key)) queued.push(entry);
      // While the wire refuses this visitor, the report is HELD in the queue,
      // never sent (greptile on #1442: a slot mounting AFTER the latch closed
      // still wrote POST /slots). The queue's own wake flushes it on sign-in,
      // whether or not any placements listener ever started the poller.
      if (identity.forbidden()) {
        ensureHeldFlush();
        return;
      }
      if (flushing) return;
      flushing = true;
      // The same deferral the first placements read uses: every slot mounting in
      // one React commit lands in ONE POST instead of one request per slot.
      queueMicrotask(flushReports);
    },
  };

  return poller;
}

function pollerFor(client: VendoClient): Poller {
  const existing = pollers.get(client);
  if (existing !== undefined) return existing;
  const created = createPoller(client);
  pollers.set(client, created);
  return created;
}

/** Subscribe one slot to the shared poller. `enabled: false` starts nothing. */
export function usePlacements(slotId: string, enabled = true): SlotPlacement {
  const { client } = useVendoProvider();
  const poller = useMemo(() => (enabled ? pollerFor(client) : undefined), [client, enabled]);
  const [, bump] = useState(0);

  useEffect(() => {
    if (poller === undefined) return;
    return poller.add(slotId, () => bump(seen => seen + 1));
  }, [poller, slotId]);

  const refresh = useCallback(async () => {
    await poller?.refresh();
  }, [poller]);

  return {
    entry: poller?.entry(slotId),
    error: poller?.error(),
    isLoading: poller === undefined ? false : poller.loading(),
    refresh,
  };
}

/** Tell the registry this slot exists, so a surface that is NOT on this page
 *  (the "Add to…" picker) can offer it as a destination. Effect-time only, so
 *  an SSR render reports nothing; deduped and batched by the shared poller. */
export function useReportSlot(slotId: string, label: string, enabled: boolean, description?: string): void {
  const { client } = useVendoProvider();
  useEffect(() => {
    if (!enabled) return;
    pollerFor(client).report(slotId, label, description);
  }, [client, description, enabled, label, slotId]);
}
