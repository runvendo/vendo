/**
 * Internal: shared compiler state for the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decisions D3/D6). Bottom of the wire-v2 module stack: compile →
 * attributes → scan → state; expression.ts also imports the shared UTF-16
 * well-formedness guard from here.
 */

import type { TreeNode } from "../tree.js";
import type { TreeQueryV2 } from "../tree-v2.js";
import type { WireIssue, WireIssueCode } from "./expression.js";

/** Internal EOF-truncation sentinel — flows up instead of a throw so every
 *  caller unwinds cleanly (same idiom as expression.ts's FAILED).
 *  Invariant: FAILED means EOF truncation, and every producer returning it
 *  leaves the cursor AT EOF — otherwise the caller resumes mid-tag and
 *  mints the tail as phantom text (breaks D6 node-count monotonicity). */
export const FAILED: unique symbol = Symbol("wire-truncated");
export type Failed = typeof FAILED;

/** Internal marker: this attribute's value was dropped (with issues already
 *  recorded); the attribute is omitted from props. */
export const DROPPED: unique symbol = Symbol("wire-attribute-dropped");
export type Dropped = typeof DROPPED;

export interface CompileState {
  readonly source: string;
  index: number;
  readonly issues: WireIssue[];
  readonly nodes: TreeNode[];
  /** Per-lowercased-component-name ordinal counters for id minting (D3). */
  readonly ordinals: Map<string, number>;
  /** D3 forward references — ALL grammar-valid `<Query id>` names in the
   *  document (collected by the compile pre-scan), so bindings may reference
   *  a query declared later in the wire. */
  readonly queryNames: ReadonlySet<string>;
  /** D3 forward references — the declared `<Island>` names (pre-scanned),
   *  for `source: "generated"` resolution. */
  readonly islandNames: ReadonlySet<string>;
  /** D3 — the host catalog names (compiler option) for source resolution. */
  readonly hostComponents: ReadonlySet<string>;
  /** D3 — hoisted `<Query>` declarations in document order. */
  readonly queries: TreeQueryV2[];
  /** The hoisted queries' names, kept beside {@link queries} so the
   *  duplicate check stays O(1) per query (a linear scan is quadratic over
   *  large wires). */
  readonly hoistedQueryNames: Set<string>;
  /** D3 — captured `<Island>` raw-TSX sources by name. */
  readonly components: Record<string, string>;
  /** §8 (limits.ts) — running UTF-8 byte total of admitted island sources. */
  componentBytes: number;
  /** §8 (limits.ts) — the once-per-compile cap issues already recorded. */
  nodeLimitIssued: boolean;
  queryLimitIssued: boolean;
  componentLimitIssued: boolean;
  /** True once `</App>` (or `<App/>`) properly closed the document. */
  appClosed: boolean;
  /** True when EOF truncated an open tag or left elements to auto-close. */
  eofTruncated: boolean;
  /** True when non-whitespace content after `</App>` was dropped. */
  droppedTrailing: boolean;
}

/** One open element: the synthetic root frame (tag `App`) sits at the
 *  bottom; component frames stack above it. */
export interface Frame {
  tag: string;
  node: TreeNode;
}

/** §8-adjacent hygiene cap (Task 5, review-mandated): at most this many
 *  issues are recorded per compile; when the cap is hit one final
 *  `issues-truncated` marker is appended (so the array never exceeds
 *  {@link WIRE_MAX_ISSUES} + 1 entries). Hostile input can otherwise mint an
 *  issue per byte. */
export const WIRE_MAX_ISSUES = 256;

const pushCapped = (state: CompileState, entry: WireIssue): void => {
  if (state.issues.length > WIRE_MAX_ISSUES) return;
  if (state.issues.length === WIRE_MAX_ISSUES) {
    state.issues.push({
      code: "issues-truncated",
      message: `issue list capped at ${WIRE_MAX_ISSUES}; further issues were not recorded`,
    });
    return;
  }
  state.issues.push(entry);
};

/** Records a compile issue with the current cursor as its best-effort source
 *  position (expression-layer issues, merged via {@link mergeIssues}, carry
 *  no index). The ONLY write paths into state.issues — both capped. */
export const issue = (state: CompileState, code: WireIssueCode, message: string): void => {
  pushCapped(state, { code, message, index: state.index });
};

/** Merges expression-layer issues (attributes.ts) through the same cap. */
export const mergeIssues = (state: CompileState, issues: readonly WireIssue[]): void => {
  for (const entry of issues) pushCapped(state, entry);
};

/** ES2024 String.prototype.isWellFormed — guaranteed at runtime by the
 *  package's engines floor (node >= 20) but absent from this tsconfig's
 *  ES2022 lib, hence the local cast (canonicalJson in jcs.ts throws on lone
 *  surrogates, so ill-formed UTF-16 must never enter props). Shared by the
 *  markup layer (attributes.ts) and the expression layer (expression.ts). */
export const isWellFormedUtf16 = (text: string): boolean =>
  (text as string & { isWellFormed(): boolean }).isWellFormed();
