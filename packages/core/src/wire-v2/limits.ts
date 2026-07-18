/**
 * Internal: §8 cap enforcement for the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan Task 5). Accumulation STOPS at each cap so the emitted tree and
 * component map always stay within the pinned limits (validateTreeV2 and
 * componentMapError both pass on every compile result, whatever the input).
 *
 * Sits beside scan.ts in the module stack (compile → attributes → scan/limits
 * → state): compile.ts calls these helpers at its accumulation sites; the
 * issue-COUNT cap lives in state.ts's issue() so every call site is covered.
 */

import {
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "../tree-limits.js";
import { issue, isWellFormedUtf16, type CompileState } from "./state.js";

// CORE-6 house idiom (component-map.ts): the contract pins the caps in
// kilobytes, so measure encoded UTF-8, not UTF-16 code units; pure-ASCII
// sources (bytes === chars) skip encoding.
const utf8 = new TextEncoder();
const NON_ASCII_PATTERN = /[\u0080-\uffff]/;
const utf8ByteLength = (source: string): number =>
  NON_ASCII_PATTERN.test(source) ? utf8.encode(source).length : source.length;

/** §8 TREE_MAX_NODES — true when another node may be appended. Beyond the
 *  cap, elements are still parsed for document structure/recovery, but no
 *  more nodes exist, so children only ever reference emitted nodes. One
 *  `node-limit` issue total, not one per refused node. */
export const claimNodeSlot = (state: CompileState): boolean => {
  if (state.nodes.length < TREE_MAX_NODES) return true;
  if (!state.nodeLimitIssued) {
    state.nodeLimitIssued = true;
    issue(
      state,
      "node-limit",
      `node limit reached (max ${TREE_MAX_NODES}); further elements parse but produce no nodes`,
    );
  }
  return false;
};

/** §8 TREE_MAX_QUERIES — true when another query may be hoisted. Over-cap
 *  queries are dropped (their pre-scanned names still resolve, so bindings
 *  to them compile to dangling $path — same as dropped duplicates). One
 *  `query-limit` issue total. */
export const claimQuerySlot = (state: CompileState): boolean => {
  if (state.queries.length < TREE_MAX_QUERIES) return true;
  if (!state.queryLimitIssued) {
    state.queryLimitIssued = true;
    issue(
      state,
      "query-limit",
      `query limit reached (max ${TREE_MAX_QUERIES}); further queries were dropped`,
    );
  }
  return false;
};

/** §8 island caps + source hygiene — admits a validated, non-duplicate
 *  island's raw TSX into the component map, or drops it:
 *  - ill-formed UTF-16 → `malformed-island` (canonicalJson downstream throws
 *    on lone surrogates, so they must never enter the map),
 *  - more than TREE_MAX_GENERATED_COMPONENTS → single `component-limit`,
 *  - source over TREE_MAX_COMPONENT_SOURCE_BYTES, or running total over
 *    TREE_MAX_TOTAL_COMPONENT_BYTES → `component-size-limit` per offender. */
export const admitIslandSource = (state: CompileState, name: string, source: string): void => {
  if (!isWellFormedUtf16(source)) {
    issue(
      state,
      "malformed-island",
      `island "${name}" source contains a lone surrogate (ill-formed UTF-16); the island was dropped`,
    );
    return;
  }
  if (Object.keys(state.components).length >= TREE_MAX_GENERATED_COMPONENTS) {
    if (!state.componentLimitIssued) {
      state.componentLimitIssued = true;
      issue(
        state,
        "component-limit",
        `generated-component limit reached (max ${TREE_MAX_GENERATED_COMPONENTS}); further islands were dropped`,
      );
    }
    return;
  }
  const bytes = utf8ByteLength(source);
  if (bytes > TREE_MAX_COMPONENT_SOURCE_BYTES) {
    issue(
      state,
      "component-size-limit",
      `island "${name}" source is ${bytes} UTF-8 bytes (max ${TREE_MAX_COMPONENT_SOURCE_BYTES}); the island was dropped`,
    );
    return;
  }
  if (state.componentBytes + bytes > TREE_MAX_TOTAL_COMPONENT_BYTES) {
    issue(
      state,
      "component-size-limit",
      `island "${name}" pushes total island source past ${TREE_MAX_TOTAL_COMPONENT_BYTES} UTF-8 bytes; the island was dropped`,
    );
    return;
  }
  state.components[name] = source;
  state.componentBytes += bytes;
};
