/**
 * The screen checking toolchain — the three machines the gauntlet needs, behind
 * one adapter slot.
 *
 * Checking a component screen means compiling it, type-checking it, and RUNNING
 * it. Today all three arrive by lazy load from this process: esbuild, the
 * `typescript` package through `createRequire`, and the QuickJS single-file
 * build. Each is reached the way it is for its own good reason, and together
 * they are the reason screen checking cannot happen anywhere but Node.
 *
 * So they are one slot rather than three: the three fire in a fixed order over
 * one screen, an implementation that has any of them has all of them, and a
 * venue that has none of them needs to hand the whole job somewhere else in one
 * call. ADAPTER RULE, as everywhere else in this repo — an explicitly passed
 * toolchain always wins, the default is exactly what this package did before
 * the slot existed, and nothing here reads the environment.
 *
 * What did NOT move is as deliberate as what did: the acorn scan, running the
 * queries and validating the tree stay with the gauntlet. They are portable
 * already, and a stage that can run anywhere should not pay to travel.
 */
import {
  bootScreen,
  flattenTree,
  pressControls,
  ScreenError,
  warmScreenEngine,
  type FlatNode,
  type FlatTree,
  type InertControl,
  type ScreenErrorKind,
  type ScreenInstance,
  type ScreenQuery,
} from "../../contract/genui/component/index.js";
import { screenTypecheckIssues } from "./screen-typecheck.js";
import { screenProgram } from "./screen-tsc.js";
import type { ComponentScreenIssue } from "./component-screen.js";

/**
 * The two forms of one screen file, and why they differ.
 *
 * - `engine` is what `bootScreen` evaluates: CommonJS, because the VM hosts a
 *   `require` and no module loader, and the AUTOMATIC jsx transform, because the
 *   VM publishes `react/jsx-runtime` and has no bare `React` global
 *   (contract/genui/component/vm-program.ts). Classic mode compiles to
 *   `React.createElement`, which is a ReferenceError in there.
 * - `scan` is what the scan reads: the module form, so the author's imports and
 *   default export are still visible (CJS renames every import into a namespace
 *   access), with the CLASSIC transform, so the compiler's own
 *   `react/jsx-runtime` import does not read as an import the author wrote.
 *
 * Their TARGETS are deliberately different, and the difference is the point.
 * The engine form stays at es2020 because it is EXECUTED, inside QuickJS, and
 * lowering is what keeps modern syntax from reaching a VM that may not
 * implement it. The scan form is only ever READ, so it is raised to es2022 to
 * lower as LITTLE as possible: a construct that was lowered away is a construct
 * the scan cannot see, and a types-only transform — the Workers scan form —
 * lowers nothing at all. The closer this form sits to that one, the closer the
 * two venues agree about the same screen. The class `static {}` guard is simply
 * the first check that noticed.
 */
export interface ScreenTransform {
  readonly engine: string;
  readonly scan: string;
}

export interface ScreenTypecheckInput {
  /** The author's TSX, verbatim — so a finding carries the author's line. */
  readonly source: string;
  /** The ambient declarations, generated caller-side from the same catalog and
   *  tool schemas whatever venue checks the screen. */
  readonly typings: string;
  /** The standard library the screen is checked against. */
  readonly lib: readonly string[];
  /** The component names the refusal sentences list. */
  readonly components: readonly string[];
}

/** `ok: false` NAMES why nothing was checked rather than returning silence a
 *  caller cannot tell apart from a clean screen: it becomes the
 *  "typecheck-unavailable" refusal, because a gate that could not read the
 *  screen must not pass it. */
export type ScreenTypecheckResult =
  | { readonly ok: true; readonly issues: readonly ComponentScreenIssue[] }
  | { readonly ok: false; readonly why: string };

export interface ScreenPaintInput {
  readonly compiledSource: string;
  readonly queries: Record<string, unknown>;
  readonly catalog: readonly string[];
  readonly now?: number;
  /** The component's props — a PORT's paint can depend on its host call site.
   *  JSON only; they cross into the VM by serialization, like every value. */
  readonly props?: Record<string, unknown>;
  /** What this SCREEN is, stamped on every node the paint emits — see
   *  {@link flattenTree}. `"ported"` is the splitter's port of a host component,
   *  and it is what lets a brick paint the host's own class. Set by the gauntlet
   *  off the dialect it graded in, never by the screen. */
  readonly source?: FlatNode["source"];
  /** The wall the screen's formats resolve against, as `bootScreen` takes it —
   *  carried through because the gate has to paint on the SAME wall the surface
   *  renders on, or a date it judged is not the date the person is shown. Unset
   *  is `"en-US"` and `"UTC"`, wherever the paint runs. */
  readonly locale?: string;
  readonly timeZone?: string;
}

/** A failed paint is DATA, not a throw: `ScreenError`'s two fields are what the
 *  gauntlet's sentence is chosen on, and an error object does not survive a
 *  venue boundary.
 *
 *  `inert` is the same posture one step further: the running screen is the only
 *  place a control can be pressed, and an instance cannot cross a venue
 *  boundary, so the presses happen HERE and what comes back is which controls
 *  did nothing — node and prop, no sentence. Required rather than optional, so
 *  a toolchain that does not press has to say so out loud instead of passing a
 *  dead button by omission.
 *
 *  `misses` is why one screen can be painted more than once. A read whose input
 *  the screen COMPUTES cannot be resolved before the component renders, so the
 *  paint names what it wanted and the caller paints again with the answers. An
 *  instance cannot cross this boundary, so a round is a fresh boot rather than a
 *  `supply` — at gate time there is no hook state to keep. Controls are pressed
 *  only on a paint that missed nothing: a screen still waiting on a read is not
 *  the screen the person is shown, so its buttons are not the ones to judge.
 *
 *  A FAILED paint carries them too, and that is what makes the loop a loop: a
 *  paint that threw while it was still waiting on a read threw against data it
 *  was never given, so the caller answers what it named and paints again. Only a
 *  throw with nothing outstanding is the screen's own. */
export type ScreenPaintResult =
  | {
    readonly ok: true;
    readonly tree: FlatTree;
    readonly inert: readonly InertControl[];
    readonly misses: readonly ScreenQuery[];
  }
  | {
    readonly ok: false;
    readonly kind: ScreenErrorKind;
    readonly message: string;
    readonly misses: readonly ScreenQuery[];
  };

export interface ScreenToolchain {
  /** Both forms of the screen. A throw is a screen that does not compile;
   *  {@link ScreenToolchainUnavailable} is a toolchain that cannot compile. */
  transform(source: string): Promise<ScreenTransform>;
  typecheck(input: ScreenTypecheckInput): Promise<ScreenTypecheckResult>;
  /** Run the screen: paint it, then press every control it painted. A throw
   *  here is the engine failing to START, which is a different refusal from a
   *  screen that would not paint. */
  paint(input: ScreenPaintInput): Promise<ScreenPaintResult>;
}

/**
 * The toolchain itself could not run — as distinct from a screen that will not
 * compile, which is the ordinary throw.
 *
 * The message is the WHY alone, never a whole sentence: the refusal belongs to
 * the gate, which writes the same one for every toolchain, and a toolchain that
 * wrote its own would be a second voice in the repair instructions.
 */
export class ScreenToolchainUnavailable extends Error {}

/** esbuild, lazily and bundler-safely: routed through a mutable binding so NO
 *  bundler statically resolves the compiler (Wrangler ignores the webpack-dialect
 *  comments and would inline esbuild's Node-only main into a Worker bundle — the
 *  portability gate's field failure). Same pattern as smoke-render.ts. */
let ESBUILD_SPECIFIER = "esbuild";

/** Strict mode is SPECIFIED on the engine form, not inherited: CommonJS output
 *  is sloppy by default, an ES module is strict already, and the two differ on
 *  frozen writes, `this` in a plain call and undeclared assignment. Without the
 *  banner a screen could pass here and throw wherever a types-only transform
 *  runs it. The scan form is the module form and needs nothing. */
const STRICT_BANNER = '"use strict";';

type ScreenForm = "engine" | "scan";

type Transform = (source: string, form: ScreenForm) => string;

/** Started at MODULE SCOPE, not on first use: the load is the slowest thing in
 *  a first check, and it has nothing to wait for. */
const esbuildTransform: Promise<Transform | undefined> = (async () => {
  try {
    const esbuild = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ ESBUILD_SPECIFIER) as typeof import("esbuild");
    return (source, form) => esbuild.transformSync(source, form === "engine"
      ? { loader: "tsx", format: "cjs", target: "es2020", jsx: "automatic", banner: STRICT_BANNER }
      : { loader: "tsx", format: "esm", target: "es2022" }).code;
  } catch {
    return undefined;
  }
})();

/** Everything this package can do in-process: esbuild, the `typescript` package,
 *  and the QuickJS VM. */
export const nodeToolchain = (): ScreenToolchain => ({
  async transform(source) {
    const transform = await esbuildTransform;
    if (transform === undefined) {
      // The why carries its own FIX, and the fix is THIS PACKAGE rather than
      // esbuild: the import above hides its specifier behind a variable and
      // bundler-ignore comments, so a bundler never sees an "esbuild" import to
      // match an external against — naming esbuild alone is inert (measured on a
      // fresh host). What has to stay out of the bundle is `@vendoai/apps`
      // itself, so this module is still resolving esbuild from Node at runtime.
      // The whole list is the one `vendo init` writes, so it pastes as it stands.
      throw new ScreenToolchainUnavailable(
        "no esbuild is reachable from @vendoai/apps — keep this package out of the server bundle (Next:"
        + ' serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/store", "@vendoai/apps"]'
        + " in next.config)",
      );
    }
    return { engine: transform(source, "engine"), scan: transform(source, "scan") };
  },

  async typecheck({ source, typings, lib, components }) {
    const program = screenProgram({ screen: source, typings, lib });
    if (!program.ok) return program;
    return { ok: true, issues: screenTypecheckIssues(program, components) };
  },

  async paint(input) {
    // Outside the try: the engine failing to start is not a verdict on the
    // screen, and the gauntlet says so in its own sentence.
    await warmScreenEngine();
    let instance: ScreenInstance | undefined;
    try {
      instance = bootScreen(input);
      const tree = flattenTree(instance.tree(), input.source);
      const misses = instance.misses();
      // Every press gets its own screen, booted from the same input — see
      // press.ts for why, and for why a pressed write never happens.
      return { ok: true, tree, misses, inert: misses.length > 0 ? [] : pressControls(tree, () => bootScreen(input)) };
    } catch (error) {
      // A throw that is not a `ScreenError` has no kind of its own. `boot` is
      // where it happened, and — like every kind but `render` and `budget` — it
      // reads back as the screen having thrown.
      return error instanceof ScreenError
        ? { ok: false, kind: error.kind, message: error.message, misses: error.misses }
        : { ok: false, kind: "boot", message: error instanceof Error ? error.message : String(error), misses: [] };
    } finally {
      // A dispose that throws is not the screen's verdict.
      try { instance?.dispose(); } catch { /* ignore */ }
    }
  },
});

let installed: ScreenToolchain | undefined;

/** The toolchain a caller that named none gets. Memoized for the process, for
 *  the reason the compiler resolution is: a deployment's toolchain does not
 *  change mid-run. */
export const defaultToolchain = (): ScreenToolchain => installed ??= nodeToolchain();

/** Test seam, mirroring `__setCompilerForTests`: the default is memoized, so the
 *  unavailable paths are unreachable from a test without one. `null` clears the
 *  memo. Returns the restore. */
export function __setToolchainForTests(candidate: ScreenToolchain | null): () => void {
  const previous = installed;
  installed = candidate ?? undefined;
  return () => { installed = previous; };
}
