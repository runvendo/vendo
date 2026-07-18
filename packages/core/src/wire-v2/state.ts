/**
 * Internal: shared compiler state for the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decisions D3/D6). Bottom of the wire-v2 module stack: compile →
 * attributes → scan → state; expression.ts also imports the shared UTF-16
 * well-formedness guard from here.
 */

import type { TreeNode } from "../tree.js";
import type { WireIssue } from "./expression.js";

/** Internal EOF-truncation sentinel — flows up instead of a throw so every
 *  caller unwinds cleanly (same idiom as expression.ts's FAILED). */
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

export const issue = (state: CompileState, code: string, message: string): void => {
  state.issues.push({ code, message });
};

/** ES2024 String.prototype.isWellFormed — guaranteed at runtime by the
 *  package's engines floor (node >= 20) but absent from this tsconfig's
 *  ES2022 lib, hence the local cast (canonicalJson in jcs.ts throws on lone
 *  surrogates, so ill-formed UTF-16 must never enter props). Shared by the
 *  markup layer (attributes.ts) and the expression layer (expression.ts). */
export const isWellFormedUtf16 = (text: string): boolean =>
  (text as string & { isWellFormed(): boolean }).isWellFormed();
