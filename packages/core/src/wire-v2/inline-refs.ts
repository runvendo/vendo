/**
 * W1-bench prototype (docs/verification/w1-bench) — inline tool references.
 *
 * Behind `compileWireV2({ inlineRefs: true })`. An inline reference is a tool
 * call written directly in a prop expression:
 *
 *   rows={invoices.list({status:"overdue"}).data}
 *   value={invoices.list({status:"overdue"}).totalCents}
 *
 * This pre-transform rewrites each inline call to a plain query binding and
 * mints the `<Query>` declaration the canonical compiler already understands,
 * deduping by tool + args (the two refs above share one fetch). Output is
 * ordinary vendo-genui/v2 wire, so the rest of the pipeline — shape checks,
 * limits, validation — is unchanged. Islands are passed through untouched
 * (their ambient `tools.x.y(args)` calls are NOT data references).
 *
 * Deliberately a source-to-source pre-pass, not a grammar change: it keeps the
 * frozen expression grammar and the canonical tree identical between the
 * `<Query>` arm and the inline arm, so the A/B measures the surface only.
 */

/** A dotted identifier followed by `(` — the head of a tool call. Requiring a
 *  dot excludes single-segment reshape ops (format/asOptions/asPoints/…). */
const CALL_HEAD = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*\(/g;

const camel = (tool: string): string => {
  const parts = tool.split(/[.\-_]/).filter(Boolean);
  const [head, ...rest] = parts;
  const name = (head ?? "q") + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[A-Za-z_]/.test(name) ? name : `q_${name}`;
};

/** Balance-match from an opening bracket; returns the index just past its
 *  matching close, or -1 if unbalanced. Handles nested () {} [] and strings. */
const matchBracket = (s: string, open: number): number => {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let i = open;
  let str: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (str !== null) {
      if (c === "\\") { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === "(" || c === "{" || c === "[") { stack.push(pairs[c]!); continue; }
    if (c === ")" || c === "}" || c === "]") {
      if (stack.length === 0 || stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
};

/** Read a trailing `.ident` / `.number` path chain starting at `i`. */
const readPath = (s: string, i: number): { path: string; end: number } => {
  let end = i;
  const re = /^(?:\.[A-Za-z_]\w*|\.\d+)+/;
  const m = re.exec(s.slice(i));
  if (m) end = i + m[0].length;
  return { path: m ? m[0] : "", end };
};

/** Rewrite one segment (a non-island slice) of wire, minting into `mint`. */
const rewriteSegment = (
  seg: string,
  mint: (tool: string, argsRaw: string) => string,
): string => {
  let out = "";
  let cursor = 0;
  CALL_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_HEAD.exec(seg)) !== null) {
    const tool = m[1]!;
    const parenOpen = m.index + m[0].length - 1;
    // A reshape pipe (`| format(...)`) is never a data source; skip if the
    // token is immediately preceded by `|`.
    const before = seg.slice(0, m.index).replace(/\s+$/, "");
    if (before.endsWith("|")) continue;
    const parenClose = matchBracket(seg, parenOpen);
    if (parenClose === -1) continue;
    const argsRaw = seg.slice(parenOpen + 1, parenClose - 1).trim();
    const { path, end } = readPath(seg, parenClose);
    const name = mint(tool, argsRaw);
    out += seg.slice(cursor, m.index) + name + path;
    cursor = end;
    CALL_HEAD.lastIndex = end;
  }
  out += seg.slice(cursor);
  return out;
};

export interface InlineRefsResult {
  wire: string;
  /** Number of inline references collapsed into minted queries. */
  minted: number;
}

/** Expand inline tool references into `<Query>` declarations + plain bindings. */
export const expandInlineRefs = (wire: string): InlineRefsResult => {
  // Split off island regions so their ambient tools.* calls are untouched.
  const segments: { text: string; island: boolean }[] = [];
  let i = 0;
  const openRe = /<Island\b[^>]*?>/g;
  const closeTag = "</Island>";
  while (i < wire.length) {
    openRe.lastIndex = i;
    const open = openRe.exec(wire);
    if (!open) { segments.push({ text: wire.slice(i), island: false }); break; }
    segments.push({ text: wire.slice(i, open.index), island: false });
    const contentStart = open.index; // include the whole island element verbatim
    const close = wire.indexOf(closeTag, open.index + open[0].length);
    const end = close === -1 ? wire.length : close + closeTag.length;
    segments.push({ text: wire.slice(contentStart, end), island: true });
    i = end;
  }

  const queries = new Map<string, { name: string; tool: string; argsRaw: string }>();
  const usedNames = new Set<string>();
  const mint = (tool: string, argsRaw: string): string => {
    const key = `${tool}|${argsRaw.replace(/\s+/g, "")}`;
    const existing = queries.get(key);
    if (existing) return existing.name;
    let base = camel(tool);
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}${n++}`;
    usedNames.add(name);
    queries.set(key, { name, tool, argsRaw });
    return name;
  };

  const rewritten = segments
    .map((s) => (s.island ? s.text : rewriteSegment(s.text, mint)))
    .join("");

  if (queries.size === 0) return { wire: rewritten, minted: 0 };

  // Emit minted <Query> declarations right after the <App ...> open tag.
  const appOpen = /<App\b[^>]*?>/.exec(rewritten);
  if (!appOpen || rewritten.slice(appOpen.index, appOpen.index + appOpen[0].length).endsWith("/>")) {
    return { wire: rewritten, minted: 0 };
  }
  const insertAt = appOpen.index + appOpen[0].length;
  const decls = [...queries.values()]
    .map(({ name, tool, argsRaw }) =>
      argsRaw.length === 0
        ? `<Query id="${name}" tool="${tool}"/>`
        : `<Query id="${name}" tool="${tool}" input={${argsRaw}}/>`,
    )
    .join("");
  const wireOut = rewritten.slice(0, insertAt) + decls + rewritten.slice(insertAt);
  return { wire: wireOut, minted: queries.size };
};
