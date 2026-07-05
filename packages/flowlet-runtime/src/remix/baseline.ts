/**
 * Baseline normalization (remix fast-edits spec, 2026-07-04): the deterministic
 * text the model patches via `edit_view` hunks. Normalization happens SERVER-
 * side so hunk coordinates are stable: LF endings, and the captured named
 * export rewritten to the default export the stage loader consumes — the model
 * never spends a hunk (or gets one wrong) on that conversion.
 *
 * `NORMALIZER_VERSION` is baked into minted envelopes; bumping it invalidates
 * stale pin bases loudly instead of mis-applying hunks against text that a
 * newer normalizer would have shaped differently.
 */
import { createHash } from "node:crypto";

export const NORMALIZER_VERSION = "1";

export interface NormalizedBaseline {
  text: string;
  baseHash: string;
  normalizerVersion: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Rewrite `exportName` to a default export. Ordered, first match wins:
 *  in-place rewrite for function/class declarations; appended
 *  `export default X;` for const/let/var and bare export lists. */
function rewriteToDefault(text: string, exportName: string): string {
  const fn = new RegExp(`export\\s+(async\\s+)?(function|class)\\s+${exportName}\\b`);
  if (fn.test(text)) {
    return text.replace(fn, (_m, asyncKw: string | undefined, kind: string) =>
      `export default ${asyncKw ?? ""}${kind} ${exportName}`,
    );
  }
  const decl = new RegExp(`export\\s+(?:const|let|var)\\s+${exportName}\\b`);
  const list = new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`);
  if (decl.test(text) || list.test(text)) {
    const nl = text.endsWith("\n") ? "" : "\n";
    return `${text}${nl}export default ${exportName};\n`;
  }
  return text;
}

/** Normalize captured source into the hunk-stable baseline text. */
export function normalizeBaseline(
  rawSource: string,
  exportName: string | undefined,
): NormalizedBaseline {
  let text = rawSource.replace(/\r\n?/g, "\n");
  if (exportName !== undefined && !/export\s+default\b/.test(text)) {
    text = rewriteToDefault(text, exportName);
  }
  return { text, baseHash: hash(text), normalizerVersion: NORMALIZER_VERSION };
}

/** Prompt-only numbered rendering; 1-based, right-aligned to 3 columns.
 *  Numbers are furniture: they exist in the prompt, never in the text the
 *  hunks apply to (and never inside `oldLines`). */
export function numberedLines(text: string): string {
  const lines = text.split("\n");
  const width = Math.max(3, String(lines.length).length);
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}| ${line}`)
    .join("\n");
}
