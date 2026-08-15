/**
 * The checks floor, as a port — blueprint §7.
 *
 * The floor's implementation lives in the server half (`server/checking/`),
 * because it needs the catalog, the tool shapes and a model. Its one hot-path
 * CALLER is the render seam, which must not import a pipeline body. So the
 * contract between them lives here on the browser-safe contract door, beside
 * {@link Finding} and {@link Check}, for the same reason those do: both sides
 * already speak the contract.
 *
 * One method: the component-screen gauntlet. The AI reviewer is deliberately NOT
 * part of it — it spends a model call, and the seam runs on every commit.
 * Judgment belongs to `validate`.
 */
import {
  type AppDocument,
  type AppId,
  type Finding,
  type TreeNode,
} from "@vendoai/core";

export interface AppFloor {
  /**
   * The component-screen gauntlet (`app.tsx`): compile, scan, typecheck, render
   * once in the sealed VM, tree-check the output.
   */
  component(input: { appId: AppId; source: string }): Promise<ComponentPaintResult>;
}

/** What the floor's component gauntlet hands the render seam: a refusal with
 *  the blocking lines, or everything one paint needs. */
export type ComponentPaintResult =
  | { ok: false; blocking: readonly string[] }
  | {
    ok: true;
    nodes: Record<string, TreeNode>;
    root: string;
    interactive: {
      compiledSource: string;
      queries: Record<string, unknown>;
      queryPlan: readonly { tool: string; input?: unknown }[];
    };
  };
export interface CheckInput {
  document: AppDocument;
  /** The user's own words — what the app was asked to be. */
  request: string;
}

/**
 * A check on the floor. Two kinds, and the difference is who decides:
 *
 * - `fact` — decidable by looking things up, so it is plain code the floor runs.
 * - `judgment` — a rule only a reader can apply, so it is one sentence that
 *   joins the reviewer's rubric as its own line.
 *
 * `kind` is OPTIONAL on the fact variant and absence means `"fact"`: checks
 * predate this field, and the floor is a safety floor. Anything that is not
 * explicitly a judgment rule is code we run — a check that silently stops
 * firing is the worst failure this contract could allow.
 */
export type Check =
  | { name: string; kind?: "fact"; run(input: CheckInput): Promise<Finding[]> }
  | { name: string; kind: "judgment"; rule: string };

/** Re-exported so the contract door is the one place a consumer reads the
 *  checking vocabulary from, even though the shape itself lives in core (L1). */
export type { Finding };
