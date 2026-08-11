import type { PendingLoosening } from "@vendoai/actions";

/**
 * The human gate on loosenings. A hardening applies itself; a loosening — lower
 * risk, wider audience, a woken tool, a cleared confirmEach mark — only ever lands
 * because a person read the quoted code and said yes. This module is that
 * reading surface: ONE aggregated diff (new proposals plus everything already
 * queued as `pending`), one question, one answer.
 *
 * Everything rendered here is UNTRUSTED. The evidence quote is verbatim repo
 * content and the reason is model prose, so both pass through `sanitize` before
 * they reach a terminal: this diff is precisely what an attacker would want to
 * spoof, because it is the line between "the model claims" and "the human
 * approved".
 */

/** Strip terminal control characters (C0 except tab, DEL, C1) from any text that
 *  originated with the model or the repo. Ported verbatim from the enrichment
 *  pass — hostile repo content can steer a model into ANSI/OSC escapes that
 *  would rewrite the very narrative the dev reviews. */
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to strip them
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export const sanitize = (line: string): string => line.replace(CONTROL_CHARS, "");

/** One queued loosening, joined to the effective value it would move away from
 *  so the diff can show a real before/after rather than just a target. */
export interface LooseningReviewItem {
  name: string;
  field: PendingLoosening["field"];
  /** The tool's EFFECTIVE current value (skeleton ⊕ standing judgment). */
  from: string | boolean;
  to: string | boolean;
  evidence: string;
  reason?: string;
}

/** Render one side of the diff. `to` is a `PendingLoosening.value` — an
 *  arbitrary string on the wire, and the "new" side of the very line a human
 *  reads to grant capability — so it is sanitized like every other untrusted
 *  string here. Booleans cannot carry control bytes; strings can. */
const show = (value: string | boolean): string => sanitize(String(value));

/** The reviewable diff: one heading per tool, then `field: old → new` with the
 *  evidence quote and reason indented under it. */
export function renderLooseningDiff(items: LooseningReviewItem[]): string[] {
  const lines: string[] = [];
  let current: string | undefined;
  for (const item of items) {
    if (item.name !== current) {
      current = item.name;
      // Tool names reaching here have been matched against tools.json, so they
      // are pattern-constrained — but this diff is the single line that decides
      // a capability grant, and "safe because of an argument three hops away" is
      // not a property worth betting a terminal on. Sanitize unconditionally.
      lines.push(`  ${sanitize(item.name)}`);
    }
    lines.push(`    ${item.field}: ${show(item.from)} → ${show(item.to)}`);
    lines.push(`      "${sanitize(item.evidence)}"`);
    if (item.reason !== undefined) lines.push(`      ${sanitize(item.reason)}`);
  }
  return lines;
}

export interface ReviewOptions {
  note: (line: string) => void;
  confirm: (question: string, defaultYes: boolean) => Promise<boolean>;
}

/**
 * Show the aggregated diff and ask once. Defaults to NO: a loosening that lands
 * because someone hit enter is not a human decision, and a non-TTY `confirm`
 * returns the default — so an unattended run queues rather than approves.
 */
export async function reviewLoosenings(
  items: LooseningReviewItem[],
  options: ReviewOptions,
): Promise<"approved" | "declined"> {
  if (items.length === 0) return "approved";
  options.note(
    `judgment: ${items.length} loosening${items.length === 1 ? " needs" : "s need"} a human decision`,
  );
  for (const line of renderLooseningDiff(items)) options.note(line);
  const tools = new Set(items.map((item) => item.name)).size;
  const approved = await options.confirm(
    `Apply ${items.length} loosening${items.length === 1 ? "" : "s"} across ${tools} tool${tools === 1 ? "" : "s"}`
    + " to .vendo/judgments.json?",
    false,
  );
  return approved ? "approved" : "declined";
}
