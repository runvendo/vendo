/**
 * Structural JSON equality, key-order independent — the ONE copy two seams share
 * (`transcript-rules.ts` and `harness-state.ts`). Both compare wire-serializable
 * UIMessage parts; a second private copy of the same comparison is how the two
 * drifted apart on undefined-key handling before this was unified.
 *
 * `ignoreUndefined` is the ONLY difference the two callers ever needed:
 *  - transcript-rules leaves it off (its `isApprovalResponse` check must treat a
 *    part carrying an explicit `undefined` prop as DISTINCT — the conservative,
 *    reject-the-flip direction);
 *  - harness-state turns it on, because a message that round-tripped the wire
 *    (which drops `undefined`) must not read as an edit against a stored copy
 *    that still carries one, or it would falsely clear the harness session.
 */
export function jsonEqual(left: unknown, right: unknown, ignoreUndefined = false): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index], ignoreUndefined));
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keep = (record: Record<string, unknown>) =>
    Object.keys(record).filter((key) => !ignoreUndefined || record[key] !== undefined);
  const leftKeys = keep(leftRecord);
  const rightKeys = keep(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => jsonEqual(leftRecord[key], rightRecord[key], ignoreUndefined));
}
