/**
 * Per-field format hints (data-fidelity hardening): render a tool's declared
 * result-field formats (`ManifestTool.formats` / `HostToolDefinition.formats`)
 * into explicit, non-negotiable prompt instructions. This is the structural
 * fix for the two browser-verified failure classes:
 * - money 100x wrong — integer-cents fields formatted raw or divided twice;
 * - dates +1 day — UTC-serialized timestamps read off the string, or calendar
 *   dates round-tripped through a timezone-shifting Date parse.
 *
 * PURE string builder, same contract as `sections.ts`: no host content, every
 * input is a parameter. Consumed by the runtime's `hostToolset` (appended to
 * each annotated tool's description, so the rule travels WITH the tool).
 */
import type { FieldFormat } from "../manifest/tool.js";

/** One vetted instruction per vocabulary value — extending the enum in
 *  `manifest/tool.ts` means writing the matching instruction here. */
const FORMAT_RULES: Record<FieldFormat, string> = {
  cents:
    "integer cents. Divide by exactly 100 and render as currency " +
    "(4018 renders as $40.18 — never $4,018.00 and never $0.40). Every total, " +
    "sum or stat tile computed from this field applies the same divide-by-100 " +
    "before display, so a summary always matches the rows it summarizes.",
  "iso-date":
    "calendar date (YYYY-MM-DD, no timezone). Render the literal day the " +
    "string names; NEVER pass it through a Date/timezone conversion — UTC " +
    "parsing shifts it by a day.",
  "iso-datetime":
    "ISO 8601 timestamp. Format it in the viewer's LOCAL time (e.g. " +
    "new Date(value).toLocaleDateString() inside a generated component); " +
    "never read the calendar date straight off the string — its UTC date can " +
    "be one day off from the local date.",
  percent:
    "a percentage already scaled for display. Render the value with a % sign " +
    "as-is; never multiply or divide it.",
};

/** Defensive label rendering: the manifest schema already restricts format-map
 *  keys to a safe identifier charset, but this renderer must hold on its own —
 *  a future schema loosening (or a code-built definition) must never let a key
 *  containing quotes/newlines break out of its bullet and inject instructions.
 *  JSON.stringify escapes quotes and all control characters into a single-line
 *  quoted string. */
function fieldLabel(field: string): string {
  return JSON.stringify(field);
}

/** Render a formats map into the tool-description block. Empty map → "". */
export function renderFormatHints(
  formats: Readonly<Record<string, FieldFormat>>,
): string {
  const entries = Object.entries(formats);
  if (entries.length === 0) return "";
  return [
    "RESULT FIELD FORMATS — non-negotiable rendering rules for this tool's result fields:",
    ...entries.map(([field, format]) => `- ${fieldLabel(field)}: ${FORMAT_RULES[format]}`),
  ].join("\n");
}
