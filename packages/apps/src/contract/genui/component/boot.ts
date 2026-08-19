/**
 * The host half of the screen engine: one sealed VM, one running screen.
 *
 * A generated screen is a React component. This runs it — really runs it, real
 * Preact, real hooks, real re-renders — inside a QuickJS WebAssembly VM, and
 * hands back DATA: the tree it painted and the tool calls its handlers asked
 * for. The screen has no DOM, no network, no clock and no host object, because
 * none of them exist in there. It is the same seal `$expr` keeps (../expr.ts)
 * with the same variant and the same discipline; this is its sibling, sized for
 * a component instead of an expression.
 *
 * THE SHAPE OF A TURN. Everything is synchronous, and every turn is the same
 * three steps: push something in (mount, an event, a tool's answer), drain
 * everything the screen scheduled off the back of it, read the paint out. The
 * drain is where Preact's state updates and passive effects run — pointed at an
 * in-VM queue this file pumps (./vm-program.ts), so a `setState` inside a
 * handler has already landed by the time `fire` returns.
 *
 * THE BUDGET IS THE VENUE'S TO CHOOSE. A deadline is the question actually
 * being asked — until the venue is one that freezes the clock while a screen
 * burns, where it is a question that can only be answered "not yet". So the
 * limit arrives as a {@link ScreenBudget} (./budget.ts): wall-clock by default,
 * interrupt counts where the clock does not move.
 *
 * A THROW LEAVES THE SCREEN STANDING. A handler that throws, or that never
 * finishes, raises a {@link ScreenError} out of `fire` — and the instance stays
 * usable, still showing the tree it last painted. That is the honest answer for
 * a surface: one broken button does not take the screen down. The exception is
 * `kind: "vm"`, where the VM itself failed and nothing in it can be trusted.
 */
import {
  isFail,
  newQuickJSWASMModuleFromVariant,
  Scope,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { stockVariant } from "../variant.js";
import { wallClockBudget, type ScreenTurn, type TurnLimit } from "./budget.js";
import { SCREEN_RUNTIME, installSource, sealSource } from "./vm-program.js";
import {
  ScreenError,
  type BootScreenOptions,
  type FireResult,
  type Intent,
  type NestedNode,
  type ScreenErrorKind,
  type ScreenInstance,
  type ScreenQuery,
} from "./types.js";

/** The VM's heap. A screen that tries to build a gigabyte of rows dies with an
 *  out-of-memory error instead of taking the surface with it — `$expr`'s limit,
 *  which the feasibility runs showed carries sixteen live Preact contexts. */
const MEMORY_LIMIT_BYTES = 32 * 1_024 * 1_024;

/** The VM's own call-stack bound, so a self-recursive component raises a
 *  catchable "stack overflow" instead of exhausting the WebAssembly stack —
 *  the one failure that would tear through this module. */
const MAX_STACK_BYTES = 512 * 1_024;

/** Times the drain may find more work waiting. A paint that schedules an update
 *  that schedules an effect is ordinary; a hundred rounds of it is a loop. */
const MAX_DRAIN_TURNS = 64;

/** Which QuickJS build the engine runs on — the argument the module factory
 *  takes, so a host may hand over a variant it loaded its own way. */
export type ScreenEngineVariant = Parameters<typeof newQuickJSWASMModuleFromVariant>[0];

const engines = new Map<ScreenEngineVariant, Promise<QuickJSWASMModule>>();
let stock: ScreenEngineVariant | null = null;

/** The variant a host handed over BY NAME, once it has. AN EXPLICITLY PASSED
 *  VARIANT WINS — the same law every adapter slot in this codebase keeps, and
 *  the only thing that makes the hatch below real: `@vendoai/ui` re-warms with
 *  no variant of its own when a screen mounts (`ui/src/tree/screen-engine.ts`),
 *  so a default that could overwrite a pinned one would discard the host's
 *  choice on the first paint. */
let pinned: ScreenEngineVariant | null = null;

/** The module every screen boots on — ONE shared slot, which {@link bootScreen}
 *  reads with no variant selector. So warming two variants is NOT a per-screen
 *  choice: a pinned variant is the module every boot gets, and absent one it is
 *  whichever warm resolved last. The per-variant map dedupes LOADING only. */
let wasm: QuickJSWASMModule | null = null;

/**
 * Load the WebAssembly. Running a screen is synchronous — this one-time load is
 * not, so a caller awaits it once before the first {@link bootScreen}.
 *
 * The default variant is the WASMFILE build with the WebAssembly handed in as
 * bytes — ../variant.ts holds it and says why the bytes may not ride inside the
 * JavaScript.
 *
 * A venue that cannot run that build passes its own, and it STICKS: every later
 * default warm is a no-op, and a default already in flight lands nowhere. That
 * is what a venue with no network and no asset URL needs — genbench's offline
 * single-bundle page, workerd's deploy-time module — because the host warms
 * once and every library-side warm after it must honour that, not race it.
 *
 * The memo is keyed on the variant itself, so warming one twice loads it once.
 * `stock` is held for the same reason: the default needs one stable key, not a
 * fresh variant per call.
 */
export async function warmScreenEngine(variant?: ScreenEngineVariant): Promise<void> {
  if (variant === undefined && pinned !== null) return;
  const key = variant ?? (stock ??= stockVariant());
  if (variant !== undefined) pinned = key;
  let booting = engines.get(key);
  if (booting === undefined) {
    booting = newQuickJSWASMModuleFromVariant(key);
    engines.set(key, booting);
  }
  const module = await booting;
  // A default warm that was already in flight when the host pinned its own must
  // not land on top of it — the early return above only catches the ones that
  // start after.
  if (pinned === null || pinned === key) wasm = module;
}

/** What a VM threw, read out before its handle goes away. */
interface Thrown {
  message: string;
  stack?: string;
}

const messageOf = (thrown: unknown): Thrown => {
  if (thrown === null || typeof thrown !== "object") return { message: String(thrown) };
  const shape = thrown as { name?: unknown; message?: unknown; stack?: unknown };
  const message = typeof shape.message === "string" ? shape.message : JSON.stringify(thrown);
  const name = typeof shape.name === "string" && shape.name !== "Error" ? `${shape.name}: ` : "";
  return {
    message: `${name}${message}`,
    ...(typeof shape.stack === "string" ? { stack: shape.stack } : {}),
  };
};

/** A paint carries data, so a key that would touch this realm's prototypes is
 *  dropped rather than parsed — the emitter refuses to write one, and this is
 *  the second lock on the same door. */
const dropPrototypeKeys = (key: string, value: unknown): unknown =>
  key === "__proto__" || key === "prototype" || key === "constructor" ? undefined : value;

/** QuickJS reports a tripped interrupt handler as exactly this. */
const isInterrupt = (thrown: Thrown): boolean => thrown.message === "InternalError: interrupted";

/** The locale a screen's formats resolve against when it names none. A default
 *  has to be SOME locale; what matters is that it is the HOST's and not the
 *  machine's — a host whose people read another one passes it. */
const DEFAULT_LOCALE = "en-US";

/** The zone likewise. UTC because a stored instant is stored in UTC, so the day
 *  a screen prints is the day the data says — and because it is the zone the
 *  benchmark's browsers are pinned to, which is the only way two contenders'
 *  dates are comparable at all. */
const DEFAULT_TIME_ZONE = "UTC";

/** Which of the host's formats one ask wants. A closed set: nothing but
 *  {@link INTL_SOURCE} can reach the bridge that carries it. */
type IntlOp =
  | "number" | "numberParts" | "numberResolved"
  | "date" | "dateParts" | "dateResolved"
  | "relative" | "relativeParts" | "relativeResolved"
  | "plural" | "pluralResolved"
  /** `Collator`'s two, which `String.prototype.localeCompare` shares — it is the
   *  same comparison under another name. */
  | "collate" | "collateResolved"
  | "display" | "displayResolved"
  /** One tag taken apart, and the tags a locales list canonicalizes to. */
  | "locale" | "canonical"
  /** `supportedLocalesOf`, one op per constructor: each format has its own locale
   *  data, so the answer genuinely differs by which one is asking. */
  | "numberSupported" | "dateSupported" | "relativeSupported"
  | "pluralSupported" | "collateSupported" | "displaySupported"
  /** `Date.prototype`'s three, which differ from `date` only in what each
   *  defaults to when the screen named no components. */
  | "day" | "time" | "stamp";

/** One locale-aware format a screen asked for, as it crosses the wall
 *  (./vm-program.ts `INTL_SOURCE`, which is the only writer of this shape). */
interface IntlAsk {
  op: IntlOp;
  locale?: string | string[];
  options?: Record<string, unknown>;
  /** The number or the instant, as its decimal spelling — JSON carries neither
   *  `NaN` nor `Infinity`, and both are things `Intl` prints. */
  value?: string;
  /** What the count counts, for the one format whose `format` takes two
   *  arguments: `"hour"` in `format(-2, "hour")` → "2 hours ago". */
  unit?: string;
  /** The STRING arguments, where a format takes those instead of a number: a
   *  collation's two operands, a display name's code, one locale tag, or the whole
   *  locales list a `supportedLocalesOf` is asked about. */
  text?: string[];
}

/**
 * One locale tag as the fields a screen reads off it, plus the two tags
 * `maximize`/`minimize` resolve to.
 *
 * Both of those read CLDR's likely-subtags table — precisely the data the VM does
 * not carry — so they are resolved HERE, once, and the VM builds each result by
 * asking again with the tag this answer named. `JSON.stringify` drops the fields
 * the tag does not carry, which is the `undefined` the standard promises for each
 * of them.
 */
const localeFacts = (locale: Intl.Locale) => ({
  /** The full identifier, extensions included — `baseName` is the language,
   *  script and region alone, and `toString()` is not the same string. */
  tag: locale.toString(),
  baseName: locale.baseName,
  calendar: locale.calendar,
  caseFirst: locale.caseFirst,
  collation: locale.collation,
  hourCycle: locale.hourCycle,
  language: locale.language,
  numberingSystem: locale.numberingSystem,
  numeric: locale.numeric,
  region: locale.region,
  script: locale.script,
  maximized: locale.maximize().toString(),
  minimized: locale.minimize().toString(),
});

/**
 * One ask, answered by the host's real `Intl`: the formatted text, or JSON where
 * the ask was for structure.
 *
 * The locale and the zone a screen did not name are the WALL's; everything it did
 * name wins, because it wrote it. The three `toLocale*` ops are answered by the
 * host's own methods rather than by `Intl.DateTimeFormat`, because the only thing
 * that separates them is which components each defaults to when a screen names
 * none — and the engine's own answer to that is the answer a browser gives.
 *
 * A format the host refuses (`currency: "USDD"`, an unknown zone) throws out of
 * here, and the bridge turns a host throw into the same `RangeError` the screen
 * would have seen in a browser.
 */
const answerIntl = (ask: IntlAsk, wall: { locale: string; timeZone: string }): string => {
  const locale = ask.locale ?? wall.locale;
  const value = Number(ask.value);
  /** The string arguments. `first`/`second` are a collation's operands, a display
   *  name's code or a locale tag; `locales` is the whole list, for the statics
   *  whose argument IS a list of locales rather than one format's locale. */
  const locales = ask.text ?? [];
  const [first = "", second = ""] = locales;
  const counts = ask.options as Intl.NumberFormatOptions | undefined;
  const dates = { timeZone: wall.timeZone, ...ask.options } as Intl.DateTimeFormatOptions;
  const words = ask.options as Intl.RelativeTimeFormatOptions | undefined;
  const forms = ask.options as Intl.PluralRulesOptions | undefined;
  const order = ask.options as Intl.CollatorOptions | undefined;
  // `DisplayNames` is the one format whose options MUST carry a `type`, so this
  // asserts rather than narrows: an ask that omits it is the host's `TypeError` to
  // raise, and it is the same one a browser raises.
  const names = ask.options as unknown as Intl.DisplayNamesOptions;
  const unit = ask.unit as Intl.RelativeTimeFormatUnit;
  switch (ask.op) {
    case "number": return new Intl.NumberFormat(locale, counts).format(value);
    case "numberParts": return JSON.stringify(new Intl.NumberFormat(locale, counts).formatToParts(value));
    case "numberResolved": return JSON.stringify(new Intl.NumberFormat(locale, counts).resolvedOptions());
    case "relative": return new Intl.RelativeTimeFormat(locale, words).format(value, unit);
    case "relativeParts": return JSON.stringify(new Intl.RelativeTimeFormat(locale, words).formatToParts(value, unit));
    case "relativeResolved": return JSON.stringify(new Intl.RelativeTimeFormat(locale, words).resolvedOptions());
    case "plural": return new Intl.PluralRules(locale, forms).select(value);
    case "pluralResolved": return JSON.stringify(new Intl.PluralRules(locale, forms).resolvedOptions());
    case "date": return new Intl.DateTimeFormat(locale, dates).format(value);
    case "dateParts": return JSON.stringify(new Intl.DateTimeFormat(locale, dates).formatToParts(value));
    case "dateResolved": return JSON.stringify(new Intl.DateTimeFormat(locale, dates).resolvedOptions());
    case "collate": return String(new Intl.Collator(locale, order).compare(first, second));
    case "collateResolved": return JSON.stringify(new Intl.Collator(locale, order).resolvedOptions());
    // `of` answers `undefined` for a code the locale has no name for, and JSON
    // carries no `undefined` — `null` crosses and the VM reads it back as one.
    case "display": return JSON.stringify(new Intl.DisplayNames(locale, names).of(first) ?? null);
    case "displayResolved": return JSON.stringify(new Intl.DisplayNames(locale, names).resolvedOptions());
    case "locale": return JSON.stringify(localeFacts(new Intl.Locale(first, ask.options as Intl.LocaleOptions)));
    case "canonical": return JSON.stringify(Intl.getCanonicalLocales(locales));
    case "numberSupported": return JSON.stringify(Intl.NumberFormat.supportedLocalesOf(locales, counts));
    case "dateSupported": return JSON.stringify(Intl.DateTimeFormat.supportedLocalesOf(locales, ask.options));
    case "relativeSupported": return JSON.stringify(Intl.RelativeTimeFormat.supportedLocalesOf(locales, words));
    case "pluralSupported": return JSON.stringify(Intl.PluralRules.supportedLocalesOf(locales, forms));
    case "collateSupported": return JSON.stringify(Intl.Collator.supportedLocalesOf(locales, order));
    case "displaySupported": return JSON.stringify(Intl.DisplayNames.supportedLocalesOf(locales, ask.options));
    case "day": return new Date(value).toLocaleDateString(locale, dates);
    case "time": return new Date(value).toLocaleTimeString(locale, dates);
    case "stamp": return new Date(value).toLocaleString(locale, dates);
  }
};

/**
 * Boot one screen. Synchronous, and long-lived: the VM, the component and its
 * hook state stay alive until {@link ScreenInstance.dispose}, because a screen
 * that reboots between clicks has no state and therefore no dialogs, no
 * selections and no drafts.
 */
export function bootScreen(options: BootScreenOptions): ScreenInstance {
  const module = wasm;
  if (module === null) {
    void warmScreenEngine().catch(() => undefined);
    throw new ScreenError("boot", "the screen engine is not warm yet — await warmScreenEngine() once before booting a screen");
  }

  const budget = options.budget ?? wallClockBudget();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const context = runtime.newContext();

  /** Tool calls the screen is awaiting, by intent id. */
  const awaiting = new Map<string, QuickJSDeferredPromise>();
  /** The intents THIS turn recorded. Reassigned per turn, never mutated across. */
  let intents: Intent[] = [];
  let minted = 0;
  let painted: string | null = null;
  let tree: NestedNode | null = null;
  let dead = false;
  /** The allowance of the turn in progress — what a budget failure names. Set
   *  by `turn`, which is the only way any of this runs. */
  let limit!: TurnLimit;

  const teardown = (): void => {
    if (dead) return;
    dead = true;
    for (const deferred of awaiting.values()) deferred.dispose();
    awaiting.clear();
    context.dispose();
    runtime.dispose();
  };

  /** A turn that failed never reached its caller, so the intents it recorded
   *  can never be settled. They are dropped rather than left pending. */
  const discardIntents = (): void => {
    for (const intent of intents) {
      awaiting.get(intent.id)?.dispose();
      awaiting.delete(intent.id);
    }
    intents = [];
  };

  const failure = (kind: ScreenErrorKind, thrown: Thrown): ScreenError =>
    isInterrupt(thrown)
      ? new ScreenError("budget", limit.message)
      : new ScreenError(kind, thrown.message, thrown.stack);

  /** Evaluate in the VM. The returned handle is the caller's to dispose; every
   *  other handle this touches is gone before it returns. */
  const evaluate = (code: string, kind: ScreenErrorKind): QuickJSHandle => {
    let result;
    try {
      result = context.evalCode(code, "screen.js");
    } catch (error) {
      // The VM itself failed — an exhausted WebAssembly stack or a broken
      // module — so nothing in it can be trusted afterwards.
      teardown();
      throw new ScreenError("vm", `the screen VM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isFail(result)) {
      const thrown = messageOf(context.dump(result.error));
      result.error.dispose();
      throw failure(kind, thrown);
    }
    return result.value;
  };

  const evalVoid = (code: string, kind: ScreenErrorKind): void => evaluate(code, kind).dispose();

  const evalString = (code: string, kind: ScreenErrorKind): string => {
    const handle = evaluate(code, kind);
    try {
      return context.getString(handle);
    } finally {
      handle.dispose();
    }
  };

  const evalNumber = (code: string, kind: ScreenErrorKind): number => {
    const handle = evaluate(code, kind);
    try {
      return context.getNumber(handle);
    } finally {
      handle.dispose();
    }
  };

  /** Run everything the screen scheduled: awaited tool answers (the VM's own
   *  job queue) and Preact's updates and effects (the engine's queue), until
   *  both are quiet. */
  const drain = (): void => {
    for (let turn = 0; turn < MAX_DRAIN_TURNS; turn += 1) {
      const jobs = runtime.executePendingJobs();
      if (isFail(jobs)) {
        const thrown = messageOf(context.dump(jobs.error));
        jobs.error.dispose();
        throw failure("handler", thrown);
      }
      const ran = evalNumber("__vendo.flush()", "handler");
      if (jobs.value === 0 && ran === 0) return;
      if (limit.spent()) throw new ScreenError("budget", limit.message);
    }
    throw new ScreenError("budget", "this screen scheduled more work after every paint and never settled");
  };

  /** An async handler's throw lands long after its call returned; the engine
   *  parks it and this is where it surfaces. */
  const checkFailure = (): void => {
    const raw = evalString("__vendo.takeFailure()", "handler");
    if (raw === "null") return;
    throw failure("handler", JSON.parse(raw) as Thrown);
  };

  /** Read the paint. `false` when it is the same paint as last time. */
  const repaint = (): boolean => {
    const json = evalString("__vendo.serialize()", "render");
    if (json === painted) return false;
    painted = json;
    tree = JSON.parse(json, dropPrototypeKeys) as NestedNode;
    return true;
  };

  /** The reads this VM has named and had no answer to, asked of a VM that may be
   *  in any state at all — this runs on the way out of a FAILED boot. Best
   *  effort by design: a failure before the runtime is installed has no
   *  `__vendo` to ask, and a dead VM cannot be asked anything. */
  const pendingMisses = (): ScreenQuery[] => {
    if (dead) return [];
    try {
      return JSON.parse(evalString("__vendo.misses()", "render")) as ScreenQuery[];
    } catch {
      return [];
    }
  };

  const turn = <T>(kind: ScreenTurn, body: () => T): T => {
    if (dead) throw new ScreenError("vm", "this screen was disposed");
    limit = budget.limit(kind);
    runtime.setInterruptHandler(limit.handler);
    try {
      return body();
    } finally {
      if (!dead) runtime.removeInterruptHandler();
    }
  };

  const currentTree = (): NestedNode => {
    if (tree === null) throw new ScreenError("render", "this screen has not painted yet");
    return tree;
  };

  // The tool bridge: a call inside the VM records an intent and gets back a
  // promise nobody in there can resolve. `settle` is the only way it ever does.
  const bridge = context.newFunction("__vendo_tool", (pathHandle, argsHandle) => {
    const path = context.dump(pathHandle) as unknown;
    const id = `i${(minted += 1)}`;
    const deferred = context.newPromise();
    awaiting.set(id, deferred);
    intents.push({
      id,
      tool: Array.isArray(path) ? path.join(".") : String(path),
      args: argsHandle === undefined ? undefined : (context.dump(argsHandle) as unknown),
    });
    return deferred.handle;
  });
  context.setProp(context.global, "__vendo_tool", bridge);
  bridge.dispose();

  // The Intl bridge: the VM is built without ICU, so every locale-aware format
  // inside it is answered out here, against the wall these options pinned. Same
  // mechanism as the tool bridge and none of its ceremony — a format is
  // synchronous, and what comes back is a string.
  const wall = { locale: options.locale ?? DEFAULT_LOCALE, timeZone: options.timeZone ?? DEFAULT_TIME_ZONE };
  const intl = context.newFunction("__vendo_intl", (askHandle) =>
    context.newString(answerIntl(JSON.parse(context.getString(askHandle)) as IntlAsk, wall)));
  context.setProp(context.global, "__vendo_intl", intl);
  intl.dispose();

  try {
    turn("boot", () => {
      evalVoid(sealSource(options.now), "boot");
      evalVoid(SCREEN_RUNTIME, "boot");
      evalVoid(installSource({
        compiledSource: options.compiledSource,
        queries: options.queries,
        catalog: options.catalog,
      }), "boot");
      drain();
      checkFailure();
      repaint();
    });
  } catch (error) {
    // Read the reads BEFORE the VM goes: a boot that threw while it was still
    // waiting on one threw against data it was never given, and the caller
    // running the supply loop needs to know which.
    const asked = pendingMisses();
    teardown();
    throw bootFailure(error, options.compiledSource, asked);
  }

  return {
    tree: currentTree,

    fire(handlerId: string, event?: unknown): FireResult {
      return turn("op", () => {
        intents = [];
        try {
          evalVoid(`__vendo.fire(${JSON.stringify(handlerId)}, ${literal(event)})`, "handler");
          drain();
          checkFailure();
          repaint();
        } catch (error) {
          discardIntents();
          throw error;
        }
        return { tree: currentTree(), intents };
      });
    },

    settle(intentId: string, result: unknown): FireResult | null {
      return turn("op", () => {
        const deferred = awaiting.get(intentId);
        if (deferred === undefined) {
          throw new ScreenError("handler", `no tool call "${intentId}" is waiting on this screen — it was already settled, or it belongs to a screen that has since been disposed`);
        }
        const answer = readOutcome(result);
        // Not an answer yet, only news: an approval to collect or a connection
        // to make. The screen stays exactly as it is — still awaiting, still
        // showing whatever "working" state it set — for the settle that carries
        // the real outcome.
        if (answer.kind === "waiting") return null;
        awaiting.delete(intentId);
        intents = [];
        try {
          Scope.withScope((scope) => {
            if (answer.kind === "ok") {
              deferred.resolve(scope.manage(evaluate(`JSON.parse(${JSON.stringify(literal(answer.output))})`, "handler")));
            } else {
              // A refusal reaches the screen as a rejected promise, so a
              // handler's own try/catch is what handles it — and a handler with
              // no try/catch raises out of here with the message intact.
              deferred.reject(scope.manage(context.newError(answer.message)));
            }
          });
          deferred.dispose();
          // The code resuming after the await is still the handler's, so its
          // tool calls are still an event's.
          evalVoid("__vendo.resume()", "handler");
          drain();
          checkFailure();
        } catch (error) {
          discardIntents();
          throw error;
        }
        const changed = repaint();
        return changed || intents.length > 0 ? { tree: currentTree(), intents } : null;
      });
    },

    misses(): ScreenQuery[] {
      return turn("op", () => JSON.parse(evalString("__vendo.misses()", "render")) as ScreenQuery[]);
    },

    supply(results: Record<string, unknown>): NestedNode {
      // A boot's turn, because a supply repaints the WHOLE screen against real
      // data for the first time — the same work the first paint did, not an
      // event's fifth of a second.
      return turn("boot", () => {
        evalVoid(`__vendo.supply(${JSON.stringify(literal(results))})`, "render");
        drain();
        checkFailure();
        repaint();
        return currentTree();
      });
    },

    dispose: teardown,
  };
}

/** What one settled tool call means to the promise the screen is awaiting. */
type Answer =
  | { kind: "ok"; output: unknown }
  | { kind: "failed"; message: string }
  | { kind: "waiting" };

/**
 * Read a `ToolOutcome` (`@vendoai/core`) as an answer to an awaited call.
 *
 * The screen's code awaits a VALUE, not an envelope — `const rows = await
 * tools.list()` is what a model writes and what the typings promise — so `ok`
 * resolves with the output alone and every refusal becomes a rejection carrying
 * the host's own sentence. `try`/`catch` in a handler then works for exactly the
 * reasons it works everywhere else.
 *
 * A bare value that is not an outcome at all resolves as itself. That keeps a
 * caller with a plain result (a test, a harness) working rather than handing the
 * screen an envelope it has no way to read.
 */
const readOutcome = (result: unknown): Answer => {
  if (result === null || typeof result !== "object") return { kind: "ok", output: result };
  const outcome = result as { status?: unknown; output?: unknown; error?: { message?: unknown }; reason?: unknown };
  if (typeof outcome.status !== "string") return { kind: "ok", output: result };
  switch (outcome.status) {
    case "ok":
      return { kind: "ok", output: outcome.output };
    case "error":
      return { kind: "failed", message: typeof outcome.error?.message === "string" ? outcome.error.message : "this tool call failed" };
    case "blocked":
      return { kind: "failed", message: typeof outcome.reason === "string" ? outcome.reason : "this tool call was not allowed" };
    // An approval to collect or a connection to make: the host is mid-flow, and
    // the call has not been answered either way. Rejecting here would tell the
    // screen it failed; staying pending is the truth, and the host can always
    // settle it again with the outcome that lands.
    case "pending-approval":
    case "connect-required":
      return { kind: "waiting" };
    default:
      return { kind: "failed", message: `this tool call came back "${outcome.status}", which is not an outcome this screen can read` };
  }
};

/** A host value as VM source. `undefined` has no JSON, and a screen reading a
 *  settled tool answer of `undefined` should see `null`, not the string. */
const literal = (value: unknown): string => {
  const json = JSON.stringify(value === undefined ? null : value);
  return json === undefined ? "null" : json;
};

/** A failed boot, as its caller has to read it: the one hint worth naming —
 *  source compiled to the wrong format, where the parser's own complaint about a
 *  top-level `import` says nothing useful — and the reads the paint was still
 *  waiting on, which is what tells a supply loop this was a loading paint rather
 *  than a verdict. */
const bootFailure = (error: unknown, source: string, misses: readonly ScreenQuery[]): unknown => {
  if (!(error instanceof ScreenError)) return error;
  const hint = error.kind === "boot" && /^\s*(?:import|export)\s/mu.test(source)
    ? " — this source looks like an ES module, and the screen VM hosts CommonJS: compile it with esbuild's format: \"cjs\""
    : "";
  return new ScreenError(error.kind, error.message + hint, error.vmStack, misses);
};
