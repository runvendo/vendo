/**
 * The interactive bridge: one live screen behind the tree the renderer paints.
 *
 * A component screen ships BOTH halves — the flat tree of its first paint, and
 * the compiled source that can produce the next one. The served tree paints
 * immediately and the VM boots behind it, so an interactive screen is never
 * slower to appear than a static one; the moment the VM is up, a `{$handler}`
 * callback moves the screen:
 *
 *     fire(handlerId, event) → { tree, intents }
 *       tree    → flattenTree → swapped in through the SAME walk the payload
 *                 took (validation, bindings, `$state`, outcomes all unchanged)
 *       intents → each one through the renderer's existing `onAction` pipe, so
 *                 the guard, approvals and per-node outcome notices are the ones
 *                 already there — then `settle(intentId, outcome)` for whatever
 *                 the answer changes.
 *
 * A tool call that SUCCEEDED also makes the screen's own data stale — the
 * cancelled transfer is still in the list it was painted from — so the served
 * `queryPlan` re-runs down the same pipe and the answers are SUPPLIED to the
 * screen that is already standing. That is the whole refresh story: no generated
 * handler hand-patches a list it did not fetch, and nothing the person typed is
 * lost, because a supply re-renders the same component rather than booting a new
 * one.
 *
 * The same door answers the other half of a read. A `useQuery` whose input the
 * screen COMPUTES cannot be resolved before the screen renders, so the paint
 * NAMES what it wanted (`misses()`) and this file answers it — boot, ask, read,
 * supply, ask again, bounded at {@link MAX_SUPPLY_ROUNDS}.
 *
 * Four rules the shape encodes:
 *
 *  1. The screen never disappears. A VM that will not boot, a handler that
 *     throws, a budget that runs out — the last good tree stays on screen and the
 *     failure lands in the per-node outcome slot of the node that fired.
 *  2. One intent per handler at a time. Rapid-fire is the hole this closes: the
 *     second click on a cancel button is dropped HERE, not merely greyed out in
 *     the render that may not have happened yet.
 *  3. One refresh at a time. A second mutation that settles mid-refetch queues
 *     ONE more cycle rather than racing a second set of reads against the first.
 *  4. The VM boots ONCE per screen — never again. The identity is the compiled source string,
 *     not the payload object, because callers legitimately rebuild the payload
 *     object every render — an object dep would re-boot the screen (and discard
 *     everything the user typed) on every parent re-render.
 */
import type { Json, ToolOutcome } from "@vendoai/core";
import { useEffect, useRef, useState } from "react";
import { convertNode } from "./convert-payload.js";
import type { WalkTree } from "./renderer.js";
import {
  loadScreenEngine,
  queryKey,
  type Intent,
  type NestedNode,
  type ScreenEngine,
  type ScreenInstance,
  type ScreenInteractive,
  type ScreenQuery,
} from "./screen-engine.js";

export interface ScreenBridge {
  /** The tree a handler moved the screen to; `null` while the served one stands. */
  tree: WalkTree | null;
  /** Handler ids with an intent in flight — their control renders disabled. */
  inFlight: ReadonlySet<string>;
  fire(nodeId: string, handlerId: string, event?: unknown): void;
  /**
   * Re-read the plan and supply the answers to the standing screen — the same
   * cycle a changed action runs. Public for the one change that arrives from
   * OUTSIDE a press: an approval decided elsewhere, whose resumed call already
   * moved the data this screen is painted from (parked-approvals.ts).
   *
   * `fresh` boots a NEW screen on those answers instead of supplying them, which
   * discards everything the screen's own `useState` holds. Exactly one caller
   * wants that, and wants it for the state rather than the data: an approval that
   * was declined or that expired moved nothing, and the screen's latched
   * "Sending…" has no other way back.
   */
  refresh(nodeId: string, fresh?: boolean): Promise<void>;
}

export interface ScreenBridgeInput {
  /** Absent for every payload that is not a component screen. */
  interactive: ScreenInteractive | undefined;
  /** The served tree: the swap keeps its queries, data and payload extras. */
  base: WalkTree;
  catalog: readonly string[];
  /** The viewer's wall, as `ScreenBoot` takes it (screen-engine.ts). Unset is
   *  `"en-US"` in `"UTC"` — the engine's default, which is a server's wall. */
  locale?: string;
  timeZone?: string;
  /** The renderer's own action pipe — never a second call path. */
  runAction(nodeId: string, action: string, payload?: Json): Promise<ToolOutcome>;
  /** Report a screen failure into a node's outcome slot. */
  onFailure(nodeId: string, message: string): void;
}

const NO_HANDLERS: ReadonlySet<string> = new Set();

/** Times the screen may ask for another read before this stops answering. One
 *  round is a parameterized read; two is one whose input came from the first
 *  one's answer. A bound is what keeps a screen that mints a key on every render
 *  from reading forever. */
const MAX_SUPPLY_ROUNDS = 3;

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function useScreen(input: ScreenBridgeInput): ScreenBridge {
  const { interactive, base, catalog, locale, timeZone, runAction, onFailure } = input;
  const booted = useRef<{ engine: ScreenEngine; screen: ScreenInstance } | null>(null);
  const held = useRef<Parameters<ScreenBridge["fire"]> | null>(null);
  const rereading = useRef(false);
  const rereadAgain = useRef(false);
  /** Every read this screen's data is made of, by the key it is filed under: the
   *  plan the payload came with, plus whatever the paints asked for since. What a
   *  refresh re-runs. */
  const asked = useRef(new Map<string, ScreenQuery>());
  const inFlightIds = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState(NO_HANDLERS);
  const [tree, setTree] = useState<WalkTree | null>(null);
  // Boot reads these ONCE, from whatever the newest render holds — they are not
  // boot's identity, so a caller that rebuilds its `components` map (and with it
  // the catalog) every render must not re-boot the VM underneath the user.
  const latest = useRef({
    interactive,
    base,
    catalog,
    locale,
    timeZone,
    onFailure,
    fire: undefined as ScreenBridge["fire"] | undefined,
    feed: undefined as ((nodeId: string, asks: readonly ScreenQuery[]) => Promise<void>) | undefined,
  });

  const source = interactive?.compiledSource;
  useEffect(() => {
    if (source === undefined) return undefined;
    setTree(null);
    let live = true;
    void (async () => {
      try {
        const engine = await loadScreenEngine();
        if (!live) return;
        const now = latest.current;
        const screen = engine.bootScreen({
          compiledSource: source,
          queries: now.interactive?.queries ?? {},
          catalog: now.catalog,
          now: Date.now(),
          locale: now.locale,
          timeZone: now.timeZone,
        });
        booted.current = { engine, screen };
        asked.current = new Map((now.interactive?.queryPlan ?? []).map((query) => [queryKey(query), query]));
        // Whatever this boot asked for that the served answers did not carry —
        // empty for every screen the gate already settled, which is nearly all.
        void now.feed?.(now.base.root, screen.misses());
      } catch (error) {
        // A screen that cannot boot cannot move: the served tree stays exactly as
        // it painted, and the root says why rather than the surface quietly
        // ignoring every click from here on.
        if (live) latest.current.onFailure(latest.current.base.root, reason(error));
        return;
      }
      // A click that landed while the chunk was still in the air is HELD, not
      // dropped — the boot window is the one moment the screen looks ready and
      // isn't.
      const pending = held.current;
      held.current = null;
      if (pending) latest.current.fire?.(...pending);
    })();
    return () => {
      live = false;
      booted.current?.screen.dispose();
      booted.current = null;
      held.current = null;
    };
  }, [source]);

  const mark = (handlerId: string, busy: boolean): void => {
    if (busy) inFlightIds.current.add(handlerId);
    else inFlightIds.current.delete(handlerId);
    setInFlight(new Set(inFlightIds.current));
  };

  /** Paint a step's tree: the engine flattens it, and it enters the walk through
   *  the same conversion the served payload took, so a `$handler` and an
   *  `action` prop mean the same thing on the swap as on the first paint. */
  const paint = (engine: ScreenEngine, next: NestedNode): void => {
    const flat = engine.flattenTree(next);
    setTree((current) => ({ ...(current ?? base), nodes: Object.values(flat.nodes).map(convertNode), root: flat.root }));
  };

  const contained = <T,>(nodeId: string, work: () => T): T | undefined => {
    try {
      return work();
    } catch (error) {
      onFailure(nodeId, reason(error));
      return undefined;
    }
  };

  /**
   * Answer reads and hand them to the screen, until it stops asking.
   *
   * The screen is never rebooted: `supply` merges the answers and re-renders the
   * component that is already running, so a dialog stays open, a draft stays
   * typed, and a selection stays selected across a refresh.
   */
  const feed = async (nodeId: string, first: readonly ScreenQuery[]): Promise<void> => {
    let asks = first;
    for (let round = 0; asks.length > 0 && round < MAX_SUPPLY_ROUNDS; round += 1) {
      const read = await Promise.all(asks.map(async (query) => {
        const outcome = await runAction(nodeId, query.tool, query.input as Json);
        // A read that failed leaves its key absent — the screen renders that query
        // empty, and the failure is already on the node through `runAction`.
        return [queryKey(query), outcome.status === "ok" ? outcome.output : undefined] as const;
      }));
      for (const query of asks) asked.current.set(queryKey(query), query);
      const instance = booted.current;
      // The surface may have unmounted (and the VM been disposed) while the reads
      // were out.
      if (instance === null) return;
      const next = contained(nodeId, () => {
        paint(instance.engine, instance.screen.supply(Object.fromEntries(read)));
        return instance.screen.misses();
      });
      if (next === undefined) return;
      asks = next;
    }
  };

  /** Read everything this screen's data is made of, again. */
  const reread = (nodeId: string): Promise<void> => feed(nodeId, [...asked.current.values()]);

  /**
   * Read everything again and boot a FRESH screen on the answers.
   *
   * The one path that still reboots, and the reason is the screen's own state
   * rather than its data. A generated handler latches "Sending…" before it awaits;
   * an approval that was DECLINED or that expired moved nothing and resolved
   * nothing, so the latch has no other way back — a supply re-renders the same
   * hooks still holding the same flag, and the person is left looking at a
   * disabled button forever. A fresh boot clears it, and somebody who declined
   * loses nothing worth keeping. Every other path supplies, and keeps what they
   * typed.
   */
  const reboot = async (nodeId: string): Promise<void> => {
    if (source === undefined) return;
    const read = await Promise.all([...asked.current.values()].map(async (query) => {
      const outcome = await runAction(nodeId, query.tool, query.input as Json);
      return [queryKey(query), outcome.status === "ok" ? outcome.output : undefined] as const;
    }));
    const instance = booted.current;
    if (instance === null) return;
    const asks = contained(nodeId, () => {
      // Boot BEFORE disposing: a boot that throws leaves the screen it replaces
      // alive and still interactive, showing the tree it already had.
      const next = instance.engine.bootScreen({
        compiledSource: source,
        queries: Object.fromEntries(read),
        catalog,
        now: Date.now(),
        locale,
        timeZone,
      });
      instance.screen.dispose();
      booted.current = { engine: instance.engine, screen: next };
      paint(instance.engine, next.tree());
      return next.misses();
    });
    if (asks !== undefined) await feed(nodeId, asks);
  };

  const refresh = async (nodeId: string, fresh = false): Promise<void> => {
    if (rereading.current) {
      rereadAgain.current = true;
      return;
    }
    rereading.current = true;
    try {
      do {
        rereadAgain.current = false;
        await (fresh ? reboot(nodeId) : reread(nodeId));
      } while (rereadAgain.current);
    } finally {
      rereading.current = false;
    }
  };

  /** Run a batch of intents and everything settling them asks for. Answers
   *  whether any of them CHANGED something, which is what the refresh waits on. */
  const pump = async (nodeId: string, intents: readonly Intent[]): Promise<boolean> => {
    const changed = await Promise.all(intents.map(async (intent) => {
      const outcome = await runAction(nodeId, intent.tool, intent.args as Json);
      // Re-read: the surface may have unmounted (and the VM been disposed) while
      // the tool was out.
      const instance = booted.current;
      if (instance === null) return false;
      const settled = contained(nodeId, () => {
        const step = instance.screen.settle(intent.id, outcome);
        if (step) paint(instance.engine, step.tree);
        return step;
      });
      const deeper = settled ? await pump(nodeId, settled.intents) : false;
      return outcome.status === "ok" || deeper;
    }));
    return changed.some(Boolean);
  };

  const fire: ScreenBridge["fire"] = (nodeId, handlerId, event) => {
    const instance = booted.current;
    if (instance === null) {
      held.current = [nodeId, handlerId, event];
      return;
    }
    if (inFlightIds.current.has(handlerId)) return;
    const step = contained(nodeId, () => {
      const next = instance.screen.fire(handlerId, event);
      paint(instance.engine, next.tree);
      // The press may have moved the input of a read — picking a client asks for
      // THAT client's invoices — so the paint it caused names a key nobody has
      // answered. Every paint the person can cause has to be answered, not only
      // the boot's.
      void feed(nodeId, instance.screen.misses());
      return next;
    });
    if (step === undefined || step.intents.length === 0) return;
    // The control stays disabled through the refresh, not merely through the
    // call: a button that re-arms over data already known to be stale is the
    // double-cancel hole with one extra step in it.
    mark(handlerId, true);
    void pump(nodeId, step.intents)
      .then((changed) => changed ? refresh(nodeId) : undefined)
      .finally(() => mark(handlerId, false));
  };

  // Every closure above belongs to THIS render (as `invoke` does in the renderer);
  // boot's continuation is the one caller that outlives its own render, so it
  // reaches the newest one through here.
  latest.current = { interactive, base, catalog, locale, timeZone, onFailure, fire, feed };

  return { tree, inFlight, fire, refresh };
}
