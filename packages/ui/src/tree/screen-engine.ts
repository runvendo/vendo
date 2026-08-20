/**
 * The screen engine, as the renderer speaks to it.
 *
 * `bootScreen` / `flattenTree` live behind `@vendoai/apps/contract` — the
 * browser-safe door `@vendoai/ui` is allowed to reach (enforced in
 * `scripts/dependency-guard.mjs`). Two things about this module:
 *
 *  - The load is DEFERRED. The engine carries a JavaScript VM; a payload with no
 *    `interactive` half must not pay for it, and an interactive screen paints its
 *    served tree before the VM exists, so nothing on screen waits for the chunk.
 *  - The load is PROBED. `@vendoai/ui` and `@vendoai/apps` are separately
 *    published packages, so a host can hold a `ui` that speaks screens over an
 *    `apps` that does not. Probed, that is one contained notice on the screen's
 *    root; unprobed, it is a `TypeError` on the user's first click.
 *
 * The declarations below are the seam itself — the renderer's half of the frozen
 * `bootScreen` contract.
 */
import type { TreeNode } from "@vendoai/core";

/** One read the screen's data comes from — the refetch's unit of work. */
export interface ScreenQuery {
  tool: string;
  input?: unknown;
}

/** The name one read's answer is filed under. The engine's own `queryKey`
 *  (`apps/contract/genui/component/types.ts`) and the VM's `keyOf`
 *  (`vm-program.ts`) are the same law — this is the copy `@vendoai/ui` may hold,
 *  since the engine itself only ever arrives by deferred import. */
export const queryKey = ({ tool, input }: ScreenQuery): string =>
  input === undefined ? tool : `${tool} ${JSON.stringify(input)}`;

/** The interactive half of a component-screen payload. */
export interface ScreenInteractive {
  /** The screen's compiled source — the program the VM runs. */
  compiledSource: string;
  /** Resolved query results, keyed by {@link queryKey}, as of the served paint.
   *  The refetch rebuilds this record with the same keys. */
  queries: Record<string, unknown>;
  /** A PORTED screen's mount props — the values the served paint rendered
   *  with. The bridge's own VM must boot with the SAME props, or the first
   *  click that moves the screen paints the component's no-props branch. */
  props?: Record<string, unknown>;
  /**
   * How to read that data again. A mutation the screen fires makes the served
   * numbers stale — the cancelled transfer is still in the list — so the whole
   * plan re-runs after one succeeds and the answers are SUPPLIED to the screen
   * that is already standing. That is why no generated handler has to hand-patch
   * its own state, and why nothing the person typed is lost when it happens.
   */
  queryPlan?: readonly ScreenQuery[];
}

/** A tool call the screen asked for while handling an event. */
export interface Intent {
  id: string;
  tool: string;
  args: unknown;
}

/** The engine's nested tree. The renderer only ever hands it back to
 *  `flattenTree`, so its shape stays the engine's business. */
export type NestedNode = unknown;

/** What a fired handler (or a settled intent) left behind: the tree to paint,
 *  and the tool calls the screen wants made. */
export interface ScreenStep {
  tree: NestedNode;
  intents: readonly Intent[];
}

export interface ScreenInstance {
  tree(): NestedNode;
  fire(handlerId: string, event?: unknown): ScreenStep;
  /** `null` when the result moved nothing the screen renders. */
  settle(intentId: string, result: unknown): ScreenStep | null;
  /** Reads the paints so far asked for and had no answer to — a query whose input
   *  the screen computed, which nothing could resolve before it rendered. Taken:
   *  asking twice does not name the same read twice. */
  misses(): ScreenQuery[];
  /** Answers, keyed by {@link queryKey}, merged in and RE-RENDERED — not
   *  rebooted, so everything `useState` holds survives. */
  supply(results: Record<string, unknown>): NestedNode;
  dispose(): void;
}

export interface ScreenBoot {
  compiledSource: string;
  queries: Record<string, unknown>;
  /**
   * Every component name this surface can render — the Kit plus whatever the
   * host registered. Names are all a browser holds: prop schemas and
   * descriptions are server-side, so a richer catalog would have to ride the
   * payload.
   */
  catalog: readonly string[];
  /** The screen's clock at boot; the VM has no `Date` of its own. */
  now?: number;
  /** Mount props for the component — see {@link ScreenInteractive.props}. */
  props?: Record<string, unknown>;
  /**
   * The wall the screen's `Intl` and `toLocale*` calls resolve against when they
   * name none: a locale, and an IANA zone. The VM has no ICU of its own either —
   * every one of those calls is answered by the host's real `Intl` against these
   * two — so a surface that leaves them unset paints `"en-US"` in `"UTC"`, which
   * is a server's wall and not the viewer's.
   */
  locale?: string;
  timeZone?: string;
}

export interface ScreenEngine {
  bootScreen(input: ScreenBoot): ScreenInstance;
  /** `source` is what the SERVED paint said this screen is, carried onto every
   *  node of a repaint. Without it a ported screen loses the host's classes on
   *  the first click that moves it. */
  flattenTree(root: NestedNode, source?: TreeNode["source"]): { nodes: Record<string, TreeNode>; root: string };
}

export const loadScreenEngine = async (): Promise<ScreenEngine> => {
  const door = await import("@vendoai/apps/contract") as unknown as Partial<ScreenEngine> & {
    warmScreenEngine?: () => Promise<void>;
  };
  if (typeof door.bootScreen !== "function" || typeof door.flattenTree !== "function") {
    throw new Error("this build of @vendoai/apps carries no screen engine");
  }
  // bootScreen is synchronous; the WASM behind it is not. Warm here so the
  // first boot never throws "not warm yet" into a contained notice.
  await door.warmScreenEngine?.();
  return door as ScreenEngine;
};
