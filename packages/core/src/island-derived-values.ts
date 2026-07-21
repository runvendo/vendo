/**
 * v4 wave — law 1 teeth for island math (the M12 class).
 *
 * Final gate 2026-07-21: "a currency converter for my balances" fabricated an
 * FX rate for the THIRD straight run — an island computing displayed EUR
 * values from `const RATE = 0.92`. The prompt principle ("every number comes
 * from a tool result") does not hold for constants feeding displayed math, so
 * this scanner catches the shape at compile and routes it to repair.
 *
 * Scoped NARROWLY — a false positive here poisons trust in the validator, so
 * when in doubt it does NOT flag. A violation needs ALL of:
 *   1. a hand-typed numeric literal (bare, or bound to a `const NAME = 0.92`
 *      declaration) participating in arithmetic (* / % + -),
 *   2. the other side of that math tracing to TOOL-DERIVED data (a `tools.`
 *      result or component props, propagated through declarations, useState
 *      setters, and iteration callbacks),
 *   3. the result flowing into rendered output (JSX or an `fmt` call).
 *
 * Explicitly EXEMPT (each one a legitimate hand-typed number):
 *   - the values 0, 1, and 100 (unit math and percent scaling),
 *   - style/layout math (anything inside a `style` object) and constants with
 *     layout/timing names (width/height/size/padding/gap/radius/timeout/…),
 *   - array-index arithmetic (`rows[rows.length - 1]`),
 *   - setTimeout/setInterval delay arguments.
 */
import { blankNonCode } from "./island-ambient.js";

/** Values that are unit math / percent scaling, never invented data. */
const EXEMPT_VALUES = new Set([0, 1, 100]);

/** Constant names that declare layout, sizing, or timing intent. */
const EXEMPT_NAME =
  /(width|height|size|px$|padding|gap|radius|margin|spacing|inset|offset|opacity|zoom|zindex|z_index|duration|delay|timeout|interval|poll|debounce|throttle|retry|ttl|ms$|millis|frames?$|index$|idx$|columns?$|cols?$|rows?_per|per_page|page_size|limit$|precision|decimals?$|digits$)/i;

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const ARITHMETIC = new Set(["*", "/", "%", "+", "-"]);

interface Span {
  start: number;
  end: number;
}

const inSpans = (spans: readonly Span[], index: number): boolean =>
  spans.some((span) => index >= span.start && index < span.end);

/** Walk forward from an opener to its matching closer (bounded, blanked view
 *  so delimiters inside strings/comments never miscount). */
const matchForward = (code: string, openIndex: number): number => {
  const open = code[openIndex];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    const char = code[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length - 1;
};

/** The spans of every `style` object literal — `style={{…}}` in JSX and
 *  `style: {…}` in object form. Layout math lives here by design. */
const styleSpans = (code: string): Span[] => {
  const spans: Span[] = [];
  for (const match of code.matchAll(/\bstyle\s*[=:]\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    spans.push({ start: match.index, end: matchForward(code, open) + 1 });
  }
  return spans;
};

/** The argument spans of setTimeout/setInterval calls — delays are config. */
const timerSpans = (code: string): Span[] => {
  const spans: Span[] = [];
  for (const match of code.matchAll(/\b(?:setTimeout|setInterval)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    spans.push({ start: match.index, end: matchForward(code, open) + 1 });
  }
  return spans;
};

/** Computed-member-access spans (`rows[rows.length - 1]`) — index math. */
const indexSpans = (code: string): Span[] => {
  const spans: Span[] = [];
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] !== "[") continue;
    let before = index - 1;
    while (before >= 0 && /\s/.test(code[before] as string)) before -= 1;
    const preceding = before >= 0 ? (code[before] as string) : "";
    // `[` after an identifier/`)`/`]` is member access; after anything else
    // it opens an array literal (destructuring, array values) — not an index.
    if (/[\w$)\]]/.test(preceding)) {
      spans.push({ start: index, end: matchForward(code, index) + 1 });
    }
  }
  return spans;
};

/** `fmt.money(…)` / `fmt.percent(…)` call spans — direct display formatting. */
const fmtSpans = (code: string): Span[] => {
  const spans: Span[] = [];
  for (const match of code.matchAll(/\bfmt\s*\.\s*[\w$]+\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    spans.push({ start: match.index, end: matchForward(code, open) + 1 });
  }
  return spans;
};

/** Render spans: for each JSX tag start, the innermost balanced `(…)` group
 *  containing it (the `return (…)` / attr-expression case), falling back to
 *  the tag's own line. Everything inside is display context. */
const renderSpans = (code: string): Span[] => {
  const spans: Span[] = [];
  for (const match of code.matchAll(/<[A-Za-z][\w.]*[\s/>]/g)) {
    const tagStart = match.index;
    // Nearest unmatched `(` walking backward from the tag.
    let depth = 0;
    let opener = -1;
    for (let index = tagStart - 1; index >= 0; index -= 1) {
      const char = code[index];
      if (char === ")") depth += 1;
      else if (char === "(") {
        if (depth === 0) {
          opener = index;
          break;
        }
        depth -= 1;
      }
    }
    if (opener >= 0) {
      spans.push({ start: opener, end: matchForward(code, opener) + 1 });
    } else {
      const lineStart = code.lastIndexOf("\n", tagStart) + 1;
      const lineEnd = code.indexOf("\n", tagStart);
      spans.push({ start: lineStart, end: lineEnd === -1 ? code.length : lineEnd });
    }
  }
  return spans;
};

interface Declaration {
  /** The declared names (plain, destructured object, or array pattern). */
  names: string[];
  /** The init expression text (through the terminating `;`/newline). */
  init: string;
  initStart: number;
}

/** Every `const|let|var` declaration with its init span (multi-line safe:
 *  the init runs to the first `;` or newline at bracket depth zero). */
const declarations = (code: string): Declaration[] => {
  const found: Declaration[] = [];
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\}|\[[^\]]*\])\s*=(?![=>])/g)) {
    const pattern = match[1] as string;
    const initStart = match.index + match[0].length;
    let depth = 0;
    let end = code.length;
    for (let index = initStart; index < code.length; index += 1) {
      const char = code[index] as string;
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if ((char === ";" || char === "\n") && depth <= 0) {
        end = index;
        break;
      }
    }
    const names = (pattern.match(IDENTIFIER) ?? []).filter((name) => name !== "const");
    found.push({ names, init: code.slice(initStart, end), initStart });
  }
  return found;
};

/** Whether text references any tainted name as a real identifier (never a
 *  `.member` position) or reaches `tools.` directly. */
const referencesTainted = (code: string, text: string, offset: number, tainted: ReadonlySet<string>): boolean => {
  if (/\btools\s*\./.test(text)) return true;
  for (const match of text.matchAll(IDENTIFIER)) {
    const before = code[offset + match.index - 1];
    if (before === ".") continue;
    if (tainted.has(match[0])) return true;
  }
  return false;
};

/** The component's props parameter names — props are host-bound data. */
const propsParamNames = (code: string): string[] => {
  const names: string[] = [];
  const params: string[] = [];
  const direct = /export\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(([^)]*)\)/.exec(code);
  if (direct?.[1] !== undefined) params.push(direct[1]);
  const named = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(code);
  if (named?.[1] !== undefined) {
    const component = named[1];
    const asFunction = new RegExp(`\\bfunction\\s+${component}\\s*\\(([^)]*)\\)`).exec(code);
    if (asFunction?.[1] !== undefined) params.push(asFunction[1]);
    const asArrow = new RegExp(`\\b(?:const|let|var)\\s+${component}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`).exec(code);
    if (asArrow?.[1] !== undefined) params.push(asArrow[1]);
  }
  for (const param of params) {
    names.push(...(param.match(IDENTIFIER) ?? []));
  }
  return names;
};

/** Tool/props-derived identifiers, propagated to a fixpoint through plain
 *  declarations, useState setters, and iteration-callback parameters. */
const taintedIdentifiers = (code: string): Set<string> => {
  const tainted = new Set<string>(propsParamNames(code));
  // Seed: names bound from `await tools.…`.
  for (const declaration of declarations(code)) {
    if (/^\s*await\s+tools\s*\./.test(declaration.init)) {
      for (const name of declaration.names) tainted.add(name);
    }
  }
  // Seed: `.then((res) => …)` params on tools chains.
  for (const match of code.matchAll(/\btools\s*\.[\w$.]+\s*\([^()]*\)\s*\.\s*then\s*\(\s*(?:async\s*)?\(?([^)=]*)\)?\s*=>/g)) {
    for (const name of (match[1] ?? "").match(IDENTIFIER) ?? []) tainted.add(name);
  }
  const useStatePairs: Array<{ value: string; setter: string }> = [];
  for (const match of code.matchAll(/\b(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\s*\.\s*)?useState\b/g)) {
    useStatePairs.push({ value: match[1] as string, setter: match[2] as string });
  }
  const declarationList = declarations(code);
  for (let pass = 0; pass < 10; pass += 1) {
    const sizeBefore = tainted.size;
    // Declarations whose init references tainted data.
    for (const declaration of declarationList) {
      if (declaration.names.some((name) => tainted.has(name))) continue;
      if (referencesTainted(code, declaration.init, declaration.initStart, tainted)) {
        for (const name of declaration.names) tainted.add(name);
      }
    }
    // useState values whose setter is ever called with tainted data.
    for (const pair of useStatePairs) {
      if (tainted.has(pair.value)) continue;
      for (const call of code.matchAll(new RegExp(`\\b${pair.setter}\\s*\\(`, "g"))) {
        const open = call.index + call[0].length - 1;
        const argsEnd = matchForward(code, open);
        if (referencesTainted(code, code.slice(open + 1, argsEnd), open + 1, tainted)) {
          tainted.add(pair.value);
          break;
        }
      }
    }
    // Iteration-callback params over tainted collections
    // (`accounts.map((account) => …)` taints `account`).
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)(?:\.[\w$]+|\([^()]*\))*\s*\.\s*(?:map|flatMap|filter|forEach|reduce|reduceRight|find|findLast|some|every|sort|toSorted|slice)\s*\(\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
      const base = match[1] as string;
      if (!tainted.has(base)) continue;
      const params = match[2] ?? match[3] ?? "";
      for (const name of params.match(IDENTIFIER) ?? []) tainted.add(name);
    }
    if (tainted.size === sizeBefore) break;
  }
  return tainted;
};

/** Whether a numeric-literal/constant occurrence participates in arithmetic:
 *  a `* / % + -` operator directly joining it to another value. Unary signs,
 *  `=>`, and `++`/`--` never count. */
const arithmeticAdjacent = (code: string, start: number, end: number): boolean => {
  let after = end;
  while (after < code.length && /[ \t]/.test(code[after] as string)) after += 1;
  const operatorAfter = code[after];
  if (operatorAfter !== undefined && ARITHMETIC.has(operatorAfter)
    && code[after + 1] !== operatorAfter && code[after + 1] !== "=" && code[after + 1] !== ">") {
    return true;
  }
  let before = start - 1;
  while (before >= 0 && /[ \t]/.test(code[before] as string)) before -= 1;
  const operatorBefore = code[before];
  if (operatorBefore === undefined || !ARITHMETIC.has(operatorBefore)) return false;
  if (code[before - 1] === operatorBefore || code[before - 1] === "=") return false;
  // A `-`/`+` reached from an opener/comma/assignment is a unary sign.
  let beforeOperator = before - 1;
  while (beforeOperator >= 0 && /[ \t]/.test(code[beforeOperator] as string)) beforeOperator -= 1;
  const left = beforeOperator >= 0 ? (code[beforeOperator] as string) : "";
  return /[\w$)\]]/.test(left);
};

/** The declared variable an expression at `index` is assigned to, if the
 *  enclosing declaration's init covers it. */
const assignmentTarget = (declarationList: readonly Declaration[], index: number): Declaration | undefined =>
  declarationList.find((declaration) =>
    index >= declaration.initStart && index < declaration.initStart + declaration.init.length
    && declaration.names.length > 0);

/** Whether the value in `names` (or anything derived from it) reaches display:
 *  an occurrence inside a render span or an fmt call. Derivation follows the
 *  same declaration/setter propagation as taint. */
const reachesRender = (
  code: string,
  seeds: readonly string[],
  declarationList: readonly Declaration[],
  display: readonly Span[],
): boolean => {
  const carriers = new Set(seeds);
  for (let pass = 0; pass < 10; pass += 1) {
    const sizeBefore = carriers.size;
    for (const declaration of declarationList) {
      if (declaration.names.some((name) => carriers.has(name))) continue;
      if (referencesTainted(code, declaration.init, declaration.initStart, carriers)) {
        for (const name of declaration.names) carriers.add(name);
      }
    }
    if (carriers.size === sizeBefore) break;
  }
  for (const match of code.matchAll(IDENTIFIER)) {
    if (!carriers.has(match[0])) continue;
    if (code[match.index - 1] === ".") continue;
    if (inSpans(display, match.index)) return true;
  }
  return false;
};

/**
 * Law 1 extension (M12): hand-typed numeric constants participating in
 * arithmetic with tool-derived values that flow into rendered output. One
 * violation per constant/literal, message written to teach the repair.
 */
export function islandDerivedValueViolations(source: string): string[] {
  const code = blankNonCode(source);
  const exempt = [...styleSpans(code), ...timerSpans(code), ...indexSpans(code)];
  const display = [...renderSpans(code), ...fmtSpans(code)];
  const declarationList = declarations(code);
  const tainted = taintedIdentifiers(code);
  if (tainted.size === 0) return [];

  // Suspect constants: `const NAME = <number>` — or a hand-typed rate TABLE
  // (`const RATES = { EUR: 0.92, GBP: 0.79 }` / `[0.92, 1.08]`) — with a
  // non-exempt name and at least one non-exempt numeric value.
  const constants = new Map<string, string>();
  for (const declaration of declarationList) {
    const name = declaration.names.length >= 1 ? (declaration.names[0] as string) : undefined;
    if (name === undefined || EXEMPT_NAME.test(name)) continue;
    const init = declaration.init.trim();
    const literal = /^(-?\d+(?:\.\d+)?)$/.exec(init);
    if (literal !== null) {
      const value = Number(literal[1]);
      if (EXEMPT_VALUES.has(Math.abs(value))) continue;
      constants.set(name, `${name} = ${literal[1]}`);
      continue;
    }
    // Object/array literals whose values are ALL hand-typed numbers. The
    // declaration must bind exactly one name (a destructured pattern is not
    // a constant table).
    if (declaration.names.length !== 1) continue;
    const table = /^[{[]([^{}[\]]*)[}\]]$/.exec(init);
    if (table === null) continue;
    const entries = (table[1] as string).split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (entries.length === 0) continue;
    // Keys may be blanked string literals (blankNonCode keeps delimiters).
    const values = entries.map((entry) => /^(?:(?:["'][^"']*["']|[\w$]+)\s*:\s*)?(-?\d+(?:\.\d+)?)$/.exec(entry));
    if (values.some((match) => match === null)) continue;
    if (!values.some((match) => !EXEMPT_VALUES.has(Math.abs(Number(match?.[1]))))) continue;
    constants.set(name, `${name} = ${init.length > 60 ? `${init.slice(0, 57)}…` : init}`);
  }

  const violations: string[] = [];
  const flagged = new Set<string>();
  const lineAround = (index: number): { text: string; start: number } => {
    const start = code.lastIndexOf("\n", index) + 1;
    const end = code.indexOf("\n", index);
    return { text: code.slice(start, end === -1 ? code.length : end), start };
  };
  const flag = (key: string, described: string): void => {
    if (flagged.has(key)) return;
    flagged.add(key);
    violations.push(
      `computes displayed values from the hand-typed constant ${described} — a constant feeding displayed math is invented data (law 1): derive it from a tool result, or render an honest <Disclaimer/> that the rate/value isn't available on this host.`,
    );
  };
  // A constant table participates through its lookup (`RATES[cur] * total`),
  // so adjacency is checked past any trailing member/index chain.
  const extendPastChain = (from: number): number => {
    let end = from;
    for (;;) {
      if (code[end] === "." && /[A-Za-z_$]/.test(code[end + 1] ?? "")) {
        end += 2;
        while (end < code.length && /[\w$]/.test(code[end] as string)) end += 1;
      } else if (code[end] === "[") {
        end = matchForward(code, end) + 1;
      } else {
        return end;
      }
    }
  };
  const checkOccurrence = (key: string, described: string, start: number, rawEnd: number): void => {
    if (flagged.has(key)) return;
    if (inSpans(exempt, start)) return;
    const end = extendPastChain(rawEnd);
    if (!arithmeticAdjacent(code, start, end)) return;
    // The other side of the math must trace to tool/props data — checked on
    // the surrounding line so unrelated tainted code never triggers it.
    const line = lineAround(start);
    const masked = line.text.slice(0, start - line.start) + " ".repeat(end - start) + line.text.slice(end - line.start);
    if (!referencesTainted(code, masked, line.start, tainted)) return;
    // …and the result must flow into rendered output.
    const target = assignmentTarget(declarationList, start);
    const rendered = target !== undefined
      ? reachesRender(code, target.names, declarationList, display)
      : inSpans(display, start);
    if (!rendered) return;
    flag(key, described);
  };

  for (const [name, described] of constants) {
    for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      if (code[match.index - 1] === ".") continue;
      checkOccurrence(name, described, match.index, match.index + name.length);
    }
  }
  // Bare numeric literals in arithmetic with tainted data (`total * 0.92`).
  for (const match of code.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$.])/g)) {
    const value = Number(match[1]);
    if (EXEMPT_VALUES.has(Math.abs(value))) continue;
    checkOccurrence(`literal:${match[1]}`, `${match[1]}`, match.index, match.index + (match[1] as string).length);
  }
  return violations;
}
