/**
 * Deterministic, shape-stable tool-output capping (context-engineering spec
 * §5). Applied at every ingestion point where tool results enter a model
 * context (chat Composio wrap, voice bridge, React host-tool runner, voice
 * driver). Isomorphic: no Node APIs.
 *
 * Shape stability is the hard rule: truncation never fabricates data. Markers
 * appear only INSIDE truncated strings and (optionally) as one reserved
 * `_truncation` note at the ROOT of object results. Array elements are
 * dropped, never replaced with marker rows, so bound views and calculations
 * keep working on capped data.
 */

export interface CapBudget {
  /** Target ceiling for the serialized result, in characters. */
  maxChars: number;
  /** Max elements kept per array (tightened automatically when over budget). */
  maxArrayItems?: number;
  /** Max characters kept per string (tightened automatically when over budget). */
  maxStringChars?: number;
  /** Attach the note as a reserved `_truncation` key on plain-object results. */
  attachNote?: boolean;
}

export interface CappedResult {
  result: unknown;
  truncated: boolean;
  /** Human/model-readable summary of what was cut, when anything was. */
  note?: string;
}

const TRUNCATED_SUFFIX = " …[truncated; ask for a specific field if you need more]";
const BINARY_MARKER = "[binary data omitted]";

function looksLikeHtml(s: string): boolean {
  return s.length > 300 && /<\/?(html|body|div|table|p|span|td|tr|style|head)\b/i.test(s);
}

function looksLikeBase64(s: string): boolean {
  if (s.startsWith("data:") && s.includes(";base64,")) return true;
  // Charset alone is not enough (any repeated letter matches) — real base64
  // mixes cases and digits, or carries padding/symbol characters.
  return (
    s.length > 512 &&
    /^[A-Za-z0-9+/=\r\n]+$/.test(s) &&
    (/[+/=]/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)))
  );
}

function htmlToText(s: string): string {
  return s
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

interface Cuts {
  strings: number;
  htmlBodies: number;
  binaries: number;
  arrays: Array<{ path: string; dropped: number }>;
}

function capValue(
  value: unknown,
  maxArrayItems: number,
  maxStringChars: number,
  cuts: Cuts,
  path: string,
): unknown {
  if (typeof value === "string") {
    let s = value;
    if (looksLikeBase64(s)) {
      cuts.binaries++;
      return BINARY_MARKER;
    }
    if (looksLikeHtml(s)) {
      cuts.htmlBodies++;
      s = htmlToText(s);
    }
    if (s.length > maxStringChars) {
      cuts.strings++;
      return s.slice(0, maxStringChars) + TRUNCATED_SUFFIX;
    }
    return s;
  }
  if (Array.isArray(value)) {
    const kept = value.length > maxArrayItems ? value.slice(0, maxArrayItems) : value;
    if (kept.length < value.length) {
      cuts.arrays.push({ path: path || "/", dropped: value.length - kept.length });
    }
    return kept.map((v, i) => capValue(v, maxArrayItems, maxStringChars, cuts, `${path}/${i}`));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = capValue(v, maxArrayItems, maxStringChars, cuts, `${path}/${k}`);
    }
    return out;
  }
  return value;
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function capToolOutput(result: unknown, budget: CapBudget): CappedResult {
  let maxArrayItems = budget.maxArrayItems ?? 50;
  let maxStringChars = budget.maxStringChars ?? Math.max(500, Math.floor(budget.maxChars / 4));

  let cuts: Cuts = { strings: 0, htmlBodies: 0, binaries: 0, arrays: [] };
  let capped = capValue(result, maxArrayItems, maxStringChars, cuts, "");

  // Progressively tighten (deterministically) while over budget — up to three
  // rounds, then accept the best effort rather than corrupting shape.
  for (let round = 0; round < 3 && sizeOf(capped) > budget.maxChars; round++) {
    maxArrayItems = Math.max(3, Math.floor(maxArrayItems / 2));
    maxStringChars = Math.max(120, Math.floor(maxStringChars / 2));
    cuts = { strings: 0, htmlBodies: 0, binaries: 0, arrays: [] };
    capped = capValue(result, maxArrayItems, maxStringChars, cuts, "");
  }

  const truncated =
    cuts.strings > 0 || cuts.htmlBodies > 0 || cuts.binaries > 0 || cuts.arrays.length > 0;
  if (!truncated) return { result: capped, truncated: false };

  const parts: string[] = [];
  for (const a of cuts.arrays) parts.push(`${a.dropped} item(s) dropped at ${a.path}`);
  if (cuts.htmlBodies) parts.push(`${cuts.htmlBodies} HTML body(ies) reduced to text`);
  if (cuts.binaries) parts.push(`${cuts.binaries} binary blob(s) omitted`);
  if (cuts.strings) parts.push(`${cuts.strings} long string(s) shortened`);
  const note = `Output truncated to fit context: ${parts.join("; ")}. Ask for specific fields or a narrower query if you need more.`;

  if (
    budget.attachNote &&
    capped &&
    typeof capped === "object" &&
    !Array.isArray(capped)
  ) {
    capped = { ...(capped as Record<string, unknown>), _truncation: note };
  }
  return { result: capped, truncated: true, note };
}
