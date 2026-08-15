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

/** The module every screen boots on — ONE shared slot. Every completed warm
 *  reassigns it, including a warm that only hit the memo above, and
 *  {@link bootScreen} reads it with no variant selector. So warming two variants
 *  is NOT a supported per-screen choice: the warm that resolved LAST is the
 *  module every subsequent boot gets. The per-variant map dedupes LOADING only —
 *  it does not decide which module runs a screen. */
let wasm: QuickJSWASMModule | null = null;

/**
 * Load the WebAssembly. Running a screen is synchronous — this one-time load is
 * not, so a caller awaits it once before the first {@link bootScreen}.
 *
 * The default variant is the SINGLE-FILE BROWSER build, for `$expr`'s reason:
 * the WebAssembly rides inside the JavaScript, so no host bundler has to be
 * taught to emit a `.wasm`, and it reaches for no Node builtin. The import stays
 * a literal specifier because `@vendoai/ui` depends on a bundler inlining it.
 *
 * A venue that cannot run that build passes its own variant, and the memo is
 * keyed on the variant itself, so warming one twice loads it once. `stock` is
 * held for the same reason — the default needs one stable key, not a fresh
 * import promise per call. Warming TWO variants in one process is another
 * matter: see the `wasm` slot above for what a host gets then.
 */
export async function warmScreenEngine(variant?: ScreenEngineVariant): Promise<void> {
  const key = variant ?? (stock ??= import("@jitl/quickjs-singlefile-browser-release-sync"));
  let booting = engines.get(key);
  if (booting === undefined) {
    booting = newQuickJSWASMModuleFromVariant(key);
    engines.set(key, booting);
  }
  wasm = await booting;
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
    teardown();
    throw bootHint(error, options.compiledSource);
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

/** The one boot failure worth naming: source compiled to the wrong format. The
 *  parser's own complaint about a top-level `import` says nothing useful. */
const bootHint = (error: unknown, source: string): unknown => {
  if (!(error instanceof ScreenError) || error.kind !== "boot") return error;
  if (!/^\s*(?:import|export)\s/mu.test(source)) return error;
  return new ScreenError(
    "boot",
    `${error.message} — this source looks like an ES module, and the screen VM hosts CommonJS: compile it with esbuild's format: "cjs"`,
  );
};
