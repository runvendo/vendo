/**
 * Minimal line-based unified diff for pin ship requests (06-apps §8).
 *
 * PinShipRequest.diff is "the net diff against the host baseline" a human
 * approver reviews. Component sources are small (caps in 01-core §9), so a
 * plain O(n·m) LCS is comfortably fast and keeps this dependency-free.
 */

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

const CONTEXT = 3;

const splitLines = (text: string): string[] => text === "" ? [] : text.split("\n");

type Op = { kind: "same" | "del" | "add"; line: string };

/** Longest-common-subsequence edit script over lines. */
const editScript = (before: string[], after: string[]): Op[] => {
  const rows = before.length;
  const cols = after.length;
  // lcs[i][j] = LCS length of before[i..] vs after[j..]
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", line: before[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: after[j]! });
      j += 1;
    }
  }
  while (i < rows) ops.push({ kind: "del", line: before[i++]! });
  while (j < cols) ops.push({ kind: "add", line: after[j++]! });
  return ops;
};

/**
 * Produce a standard unified diff (`--- a/…`, `+++ b/…`, `@@` hunks) between
 * two sources. Identical inputs produce an empty string.
 */
export const unifiedDiff = (label: string, before: string, after: string): string => {
  if (before === after) return "";
  const ops = editScript(splitLines(before), splitLines(after));

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let beforeLine = 1;
  let afterLine = 1;
  let trailingContext = 0;

  const flush = (): void => {
    if (current === undefined) return;
    // Trim context beyond CONTEXT lines at the hunk tail.
    while (trailingContext > CONTEXT) {
      current.lines.pop();
      current.beforeCount -= 1;
      current.afterCount -= 1;
      trailingContext -= 1;
    }
    hunks.push(current);
    current = undefined;
    trailingContext = 0;
  };

  const pending: Op[] = [];
  for (const op of ops) {
    if (op.kind === "same") {
      if (current !== undefined) {
        current.lines.push(` ${op.line}`);
        current.beforeCount += 1;
        current.afterCount += 1;
        trailingContext += 1;
        if (trailingContext > CONTEXT * 2) flush();
      } else {
        pending.push(op);
        if (pending.length > CONTEXT) pending.shift();
      }
      beforeLine += 1;
      afterLine += 1;
      continue;
    }
    if (current === undefined) {
      current = {
        beforeStart: beforeLine - pending.length,
        beforeCount: pending.length,
        afterStart: afterLine - pending.length,
        afterCount: pending.length,
        lines: pending.map((context) => ` ${context.line}`),
      };
      pending.length = 0;
    }
    trailingContext = 0;
    if (op.kind === "del") {
      current.lines.push(`-${op.line}`);
      current.beforeCount += 1;
      beforeLine += 1;
    } else {
      current.lines.push(`+${op.line}`);
      current.afterCount += 1;
      afterLine += 1;
    }
  }
  flush();

  const body = hunks.map((hunk) => {
    const beforeStart = hunk.beforeCount === 0 ? hunk.beforeStart - 1 : hunk.beforeStart;
    const afterStart = hunk.afterCount === 0 ? hunk.afterStart - 1 : hunk.afterStart;
    return [
      `@@ -${beforeStart},${hunk.beforeCount} +${afterStart},${hunk.afterCount} @@`,
      ...hunk.lines,
    ].join("\n");
  }).join("\n");

  return `--- a/${label}\n+++ b/${label}\n${body}\n`;
};
