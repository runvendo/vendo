/**
 * W1-bench prototype (docs/verification/w1-bench) — inline tool references.
 *
 * Behind `compileWire({ inlineRefs: true })`. An inline reference is a tool
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
 * (their ambient `tools.x.y(args)` calls are NOT data references), and so is
 * every call on a query's own data — a `{...}` gap is JavaScript, so
 * `spending.data.reduce(…)` is arithmetic, not a fetch.
 *
 * Deliberately a source-to-source pre-pass, not a grammar change: it keeps the
 * frozen expression grammar and the canonical tree identical between the
 * `<Query>` arm and the inline arm, so the A/B measures the surface only.
 */

/**
 * An identifier chain followed by `(` — a CANDIDATE head. Two gates decide
 * whether it is really a tool call (see {@link rewriteExpr}), and both exist
 * because a `{...}` gap is JavaScript now, where a dotted chain before `(` is
 * overwhelmingly a method on data (`spending.data.reduce(…)`,
 * `rows.map(…)`, `name.slice(…)`) rather than a tool:
 *
 *   1. the chain's ROOT must not be a declared `<Query>` id — a chain rooted at
 *      a query reads that query's data, so it is a formula, always;
 *   2. the WHOLE chain must name a known tool.
 *
 * Gate 2 used to apply to single-segment heads only, on the theory that a
 * dotted head could only ever be `invoices.list(…)`. Under the JavaScript
 * grammar that theory is false, and it minted `<Query tool="spending.data.reduce"/>`
 * out of a perfectly good total — a phantom query, an unknown tool, and a
 * binding smuggled into a query input, all from one arithmetic expression.
 */
const CALL_HEAD = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g;

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

/** The half-open ranges of the string literals in an expression. A call
 *  written inside one — `text={"call ops.team (Mon-Fri)"}` — is copy, not a
 *  call, the same distinction the expression parser makes. */
const stringSpans = (expr: string): Array<[start: number, end: number]> => {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < expr.length; i += 1) {
    const quote = expr[i] as string;
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    const start = i;
    i += 1;
    while (i < expr.length && expr[i] !== quote) i += expr[i] === "\\" ? 2 : 1;
    spans.push([start, Math.min(i, expr.length - 1)]);
  }
  return spans;
};

/** Rewrite one attribute expression, minting into `mint`. */
const rewriteExpr = (
  expr: string,
  mint: (tool: string, argsRaw: string) => string,
  knownTools: ReadonlySet<string>,
  queryIds: ReadonlySet<string>,
): string => {
  const spans = stringSpans(expr);
  let out = "";
  let cursor = 0;
  CALL_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_HEAD.exec(expr)) !== null) {
    const tool = m[1]!;
    // Gate 1 — a chain rooted at a declared query reads DATA. Only a literal
    // `<Query tool="…"/>` may create a query; every call on a query's data is a
    // formula the renderer evaluates.
    if (queryIds.has(tool.split(".")[0] as string)) continue;
    // Gate 2 — the registry decides what is a tool, dotted or not. Minting a
    // query for a name the host does not have only ever produced a blocking
    // "names unknown tool" finding one layer down.
    if (!knownTools.has(tool)) continue;
    if (spans.some(([start, end]) => m!.index > start && m!.index < end)) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBracket(expr, parenOpen);
    if (parenClose === -1) continue;
    const argsRaw = expr.slice(parenOpen + 1, parenClose - 1).trim();
    const { path, end } = readPath(expr, parenClose);
    const name = mint(tool, argsRaw);
    out += expr.slice(cursor, m.index) + name + path;
    cursor = end;
    CALL_HEAD.lastIndex = end;
  }
  out += expr.slice(cursor);
  return out;
};

/** Candidate open tag: `<` followed by a tag name. */
const TAG_NAME = /^[A-Za-z_][A-Za-z0-9_-]*/;
const ISLAND_CLOSE = "</Island>";

/** The index just past a markup string that opens at `open`. */
const endOfString = (s: string, open: number): number => {
  const quote = s[open];
  let i = open + 1;
  while (i < s.length && s[i] !== quote) i += s[i] === "\\" ? 2 : 1;
  return i + 1;
};

/**
 * Walk the markup and rewrite ONLY the attribute expression blocks, because an
 * inline reference is `attr={tool.name(args)}` and nothing else. Everything a
 * user reads — text children and double-quoted attribute values — is copied
 * through untouched: this pass used to regex the whole document, so
 * `<Text text="Contact ops.team (Mon-Fri)"/>` had its visible words rewritten
 * to `Contact opsTeam` and minted a query for a tool nobody has.
 *
 * Markup-level quoting matches `scanTagEnd` in scan.ts (double quotes and
 * brace blocks, not single quotes), so this pre-pass and the compiler proper
 * end a tag at the same character. `<Island>` bodies are raw TSX, not markup,
 * and their ambient `tools.x.y(args)` calls are not data references — so an
 * island that carries content is skipped whole, exactly as compileIsland reads
 * it (to the FIRST `</Island>`), while a self-closing one has no body to skip.
 */
const rewriteAttributes = (
  wire: string,
  mint: (tool: string, argsRaw: string) => string,
  knownTools: ReadonlySet<string>,
  queryIds: ReadonlySet<string>,
): string => {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < wire.length) {
    if (wire[i] !== "<") {
      i += 1;
      continue;
    }
    const tag = TAG_NAME.exec(wire.slice(i + 1));
    if (tag === null) {
      i += 1;
      continue;
    }
    const island = tag[0] === "Island";
    i += 1 + tag[0].length;
    let selfClosing = false;
    while (i < wire.length) {
      const char = wire[i] as string;
      if (char === ">") {
        selfClosing = wire[i - 1] === "/";
        i += 1;
        break;
      }
      if (char === '"') {
        i = endOfString(wire, i);
        continue;
      }
      if (char === "{") {
        const end = matchBracket(wire, i);
        if (end === -1) {
          i = wire.length;
          break;
        }
        if (!island) {
          out += wire.slice(copied, i + 1) + rewriteExpr(wire.slice(i + 1, end - 1), mint, knownTools, queryIds);
          copied = end - 1;
        }
        i = end;
        continue;
      }
      i += 1;
    }
    if (island && !selfClosing) {
      const close = wire.indexOf(ISLAND_CLOSE, i);
      i = close === -1 ? wire.length : close + ISLAND_CLOSE.length;
    }
  }
  return out + wire.slice(copied);
};

export interface InlineRefsResult {
  wire: string;
  /** Number of inline references collapsed into minted queries. */
  minted: number;
}

export interface InlineRefsOptions {
  /** Known tool names: enables single-segment inline heads (production
   *  extraction names like `host_listTransactions`). Dotted heads expand
   *  regardless. */
  tools?: readonly string[];
}

/** Expand inline tool references into `<Query>` declarations + plain bindings. */
export const expandInlineRefs = (wire: string, options?: InlineRefsOptions): InlineRefsResult => {
  const knownTools: ReadonlySet<string> = new Set(options?.tools ?? []);
  const queries = new Map<string, { name: string; tool: string; argsRaw: string }>();
  // Seed with names already claimed in the document — explicit <Query id="…">
  // and <Island name="…"> — so a minted name can never collide with one the
  // author declared (which would otherwise produce a duplicate-query / shadow).
  const usedNames = new Set<string>();
  // The declared query ids are also the roots a call chain may NOT start at
  // (gate 1 in rewriteExpr): `spending.data.reduce(…)` is spending's data, not
  // a tool named "spending.data.reduce".
  const queryIds = new Set<string>();
  for (const m of wire.matchAll(/<Query\b[^>]*?\bid="([^"]+)"/g)) {
    usedNames.add(m[1]!);
    queryIds.add(m[1]!);
  }
  for (const m of wire.matchAll(/<Island\b[^>]*?\bname="([^"]+)"/g)) usedNames.add(m[1]!);
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

  const rewritten = rewriteAttributes(wire, mint, knownTools, queryIds);

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
