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

/** The interactive half of a component-screen payload. */
export interface ScreenInteractive {
  /** The screen's compiled source — the program the VM runs. */
  compiledSource: string;
  /** Resolved query results, keyed by the tool that produced them, as of the
   *  served paint. The refetch rebuilds this record with the same keys. */
  queries: Record<string, unknown>;
  /**
   * How to read that data again. A mutation the screen fires makes the served
   * numbers stale — the cancelled transfer is still in the list — so the whole
   * plan re-runs after one succeeds and the screen re-boots on the answer. That
   * is why no generated handler has to hand-patch its own state.
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
}

export interface ScreenEngine {
  bootScreen(input: ScreenBoot): ScreenInstance;
  flattenTree(root: NestedNode): { nodes: Record<string, TreeNode>; root: string };
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
