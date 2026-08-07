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
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { VendoClient } from "../client.js";
// `useVendoProvider`, NOT `useVendoContext`: #852 renamed the provider-reading
// hook and gave the old name to the host-facing `useVendoContext(data)` in
// hooks/use-vendo-context.ts, which publishes into the agent's [Situation]
// channel and returns void.
import { useVendoProvider } from "../context.js";
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
}

const pollers = new WeakMap<VendoClient, Poller>();

function createPoller(client: VendoClient): Poller {
  const listeners = new Map<string, Set<() => void>>();
  const settles = new Set<ReturnType<typeof setTimeout>>();
  let entries = new Map<string, PlacementEntry>();
  let error: Error | undefined;
  let loaded = false;
  let running = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopPin: (() => void) | undefined;

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
      entries = new Map(answered.map(item => [item.slot, item]));
      error = undefined;
    } catch (reason) {
      if (mine !== generation) return;
      error = reason instanceof Error ? reason : new Error(String(reason));
    }
    loaded = true;
    announce();
  };

  // Self-scheduling, never setInterval: the next tick is armed only once the
  // current read settles, so a slow wire cannot stack overlapping requests.
  const tick = async (): Promise<void> => {
    await read();
    if (running) timer = setTimeout(() => void tick(), POLL_MS);
  };

  const start = (): void => {
    if (running) return;
    running = true;
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
    for (const settle of settles) clearTimeout(settle);
    settles.clear();
    generation += 1;
    entries = new Map();
    error = undefined;
    loaded = false;
  };

  return {
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
  };
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
