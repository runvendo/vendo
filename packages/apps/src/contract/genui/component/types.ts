/**
 * The screen engine's vocabulary — what a running screen hands back.
 *
 * A generated screen is a React component the model wrote. It runs inside a
 * sealed QuickJS VM (./boot.ts) and never touches a real DOM: what comes out is
 * DATA — a tree of component names and props, plus the tool calls its event
 * handlers asked for. The host renders that tree with its own components and
 * decides which tool calls are allowed to happen.
 *
 * Two things the shapes below encode:
 *
 * 1. **A handler is a reference, not a function.** A function cannot cross the
 *    VM boundary, so a function-valued prop is emitted as {@link HandlerRef} —
 *    `{ $handler: "h4" }` — and the renderer turns it back into a callback that
 *    calls {@link ScreenInstance.fire}. Handler ids are stable across
 *    re-renders by structural position, so a click already in flight still
 *    names the same handler after the screen repaints.
 * 2. **A tool call is an intent, not an effect.** `tools.cancel_transfer(...)`
 *    inside a handler records an {@link Intent} and returns a promise that
 *    stays pending. Nothing happens until the host runs the real tool and
 *    reports back through {@link ScreenInstance.settle}. The screen cannot
 *    reach the network, so this is the only way anything leaves it.
 */
import type { ScreenBudget } from "./budget.js";

/** A function-valued prop, as it crosses the VM boundary. */
export interface HandlerRef {
  $handler: string;
}

/** The renderer's guard: is this prop a handler the host should wire up? */
export function isHandlerRef(value: unknown): value is HandlerRef {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $handler?: unknown }).$handler === "string";
}

/**
 * One node of a rendered screen. `component` is a name from the catalog (or
 * `#text`'s siblings — a plain string child IS the text, no node needed), and
 * `props` carries only data: primitives, arrays, plain objects, and
 * {@link HandlerRef}s where the component wrote a function.
 */
export interface NestedNode {
  component: string;
  props: Record<string, unknown>;
  children: Array<NestedNode | string>;
  /** The React key the component wrote, when it wrote one. */
  key?: string;
}

/**
 * A control that was pressed and did nothing: it asked for no tool call, and
 * the screen painted nothing new. The node it sits on and the prop that carries
 * its handler.
 *
 * A FACT about one press, never a verdict. The sentence a person or a model
 * reads is written by whichever gate asked for the press ({@link pressControls}
 * is used by the save-time gauntlet), because a repair instruction belongs to
 * the gate that refuses — not to the engine that observed.
 */
export interface InertControl {
  node: string;
  prop: string;
}

/** One read a screen makes: the tool, and the input it asked with. */
export interface ScreenQuery {
  tool: string;
  input?: unknown;
}

/**
 * The name one read's answer is filed under.
 *
 * A screen reads one tool as many times as it has questions — a detail panel
 * beside a list is two reads of the same tool — so the answer cannot be keyed by
 * the tool alone. The VM keys its own store the same way (`keyOf` in
 * ./vm-program.ts): the two copies are one law and must agree.
 *
 * A read with no input keys as the bare tool name, so the common screen's data
 * reads the way it always did.
 */
export const queryKey = ({ tool, input }: ScreenQuery): string =>
  input === undefined ? tool : `${tool} ${JSON.stringify(input)}`;

/** A tool call an event handler asked for, awaiting the host's answer. */
export interface Intent {
  id: string;
  tool: string;
  args: unknown;
}

/** What one delivered event produced: the repaint, and what it wants run. */
export interface FireResult {
  tree: NestedNode;
  intents: Intent[];
}

/** A live screen. One VM, one component, as long as the surface shows it. */
export interface ScreenInstance {
  /** The current render. Cheap — the last paint, already serialized. */
  tree(): NestedNode;
  /** Deliver an event to a handler the tree named. Synchronous. */
  fire(handlerId: string, event?: unknown): FireResult;
  /**
   * Answer an {@link Intent} the screen is awaiting, with the host's whole
   * `ToolOutcome`. What the awaited `tools.*()` promise does with it:
   *
   * | outcome                              | the promise                       |
   * | ------------------------------------ | --------------------------------- |
   * | `ok`                                 | resolves with `output` alone       |
   * | `error`, `blocked`                   | rejects with the host's message    |
   * | `pending-approval`, `connect-required` | stays pending for a later settle |
   *
   * A rejection is a rejection: a handler's own `try`/`catch` handles it, and a
   * handler without one raises a {@link ScreenError} out of here with the last
   * tree still standing. A bare value that is not an outcome resolves as itself.
   *
   * `null` means nothing moved — no repaint, no new intents, nothing to do.
   */
  settle(intentId: string, result: unknown): FireResult | null;
  /**
   * The reads the paints so far asked for and had no answer to.
   *
   * A query input may be computed — `useQuery("invoices", { client: chosen })` —
   * so it cannot be known before the screen renders. The screen paints with
   * `{ data: undefined }` there — react-query's shape, so reading a field off a
   * pending read is a read and not a throw — and NAMES what it wanted; the host
   * runs those reads and hands them back through {@link supply}. Taken, not
   * copied: a read the host could not answer is asked once per round rather than
   * forever.
   */
  misses(): ScreenQuery[];
  /**
   * Answers to {@link misses}, keyed by {@link queryKey}, merged into the
   * screen's data — which RE-RENDERS the component rather than rebooting it, so
   * everything `useState` holds is still there.
   */
  supply(results: Record<string, unknown>): NestedNode;
  /** Tear the VM down. Idempotent. */
  dispose(): void;
}

export interface BootScreenOptions {
  /** The component, compiled to plain CommonJS JavaScript — not TSX. */
  compiledSource: string;
  /** Query results, keyed by {@link queryKey}, resolved BEFORE the screen boots.
   *  A read whose input the screen computes is not in here — it arrives through
   *  {@link ScreenInstance.supply} after the first paint names it. */
  queries: Record<string, unknown>;
  /** The component names the screen may name. */
  catalog: readonly string[];
  /**
   * The frozen clock. Given, `Date` exists inside the VM and always reads this
   * instant; withheld, `Date` does not exist at all — the same posture `$expr`
   * keeps, so one screen over one set of data paints the same twice.
   */
  now?: number;
  /**
   * The wall a screen's formatting resolves against: the locale and the IANA zone
   * that `Intl`, `toLocaleString` and `toLocaleDateString`/`toLocaleTimeString`
   * DEFAULT to in there. Unset is `"en-US"` and `"UTC"`.
   *
   * The host's, never the machine's — the VM has no ICU of its own, so every one
   * of those calls is answered by the host's real `Intl` (./boot.ts) and would
   * otherwise read whatever zone the process happens to sit in, which is the
   * frozen clock's problem one field over. A screen that passes its own locale or
   * `timeZone` gets it: it wrote it.
   */
  locale?: string;
  timeZone?: string;
  /**
   * What stops a screen that will not stop. Unset is `wallClockBudget()` — a
   * fifth of a second an event, two seconds a boot. A venue whose clock does not
   * advance during a synchronous burn (workerd) passes `opsBudget()` instead.
   */
  budget?: ScreenBudget;
}

/** The one node kind that is not a catalog component: a run of text. */
export const SCREEN_TEXT_NODE = "#text";

/**
 * The one file a screen IS, in the app's own directory — and, once it is stored,
 * the key it lives under in `AppDocument.source`.
 *
 * With the engine's own vocabulary because everything that has to agree about the
 * basename is downstream of the artifact: the hand that saves it, the manual that
 * teaches a model to write it, the gauntlet that checks it, the doors that read the
 * stored one back. It must stay a file the render seam watches
 * (`HOT_PATH_FILES`) or a save paints nothing — `skills/format-reference.ts` is
 * where those two names are held to each other, being the one place both are in
 * scope.
 */
export const SCREEN_FILE = "app.tsx";

/** A node of the flat tree {@link flattenTree} prints. */
export interface FlatNode {
  id: string;
  component: string;
  props: Record<string, unknown>;
  /** Child ids, in paint order. A text child is a {@link SCREEN_TEXT_NODE}. */
  children: string[];
}

export interface FlatTree {
  nodes: Record<string, FlatNode>;
  root: string;
}

/** What went wrong, and where it went wrong. */
export type ScreenErrorKind =
  /** The component would not load, or its first render threw. */
  | "boot"
  /** An event handler threw — the screen is still usable, showing its last tree. */
  | "handler"
  /** A render produced something that is not one tree. */
  | "render"
  /** The work did not finish inside the budget, or would not stop scheduling. */
  | "budget"
  /** The VM itself failed. The instance is dead. */
  | "vm";

/**
 * A failure that came from inside the screen. `message` is the in-VM message
 * verbatim — it is written to be read by whatever repairs the screen, so it is
 * passed through rather than summarized.
 */
export class ScreenError extends Error {
  constructor(
    readonly kind: ScreenErrorKind,
    message: string,
    readonly vmStack?: string,
    /**
     * The reads the paint had already NAMED and had no answer to when it threw.
     *
     * A first paint that throws while it is still waiting on a read threw
     * against data it was never given: that is a LOADING paint, not a verdict on
     * the screen. A caller running the supply loop answers these and paints
     * again. Empty is the other case — the screen threw with everything it asked
     * for in hand — and that one IS the verdict.
     */
    readonly misses: readonly ScreenQuery[] = [],
  ) {
    super(message);
    this.name = "ScreenError";
  }
}
