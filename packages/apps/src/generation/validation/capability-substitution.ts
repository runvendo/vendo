/**
 * D5 — the capability-substitution gate.
 *
 * The defect (live, Maple, 2026-07-26): asked to "approve all requests and
 * then send to Slack" on a host with no messaging tool, the generated island
 * called the PAYMENTS API as a messaging channel —
 *
 *   await tools.host_transferMoney({
 *     amount: 1,
 *     recipient_name: 'Slack Forwarding Bot',
 *     memo: 'APPROVED TRANSACTIONS: ' + summary,
 *   })
 *
 * — its own source comment admitting the substitution. Money really moves.
 * Measured incidence: 9% of baseline apps reach a mutating tool from island
 * source. When the host lacks a capability the ask needs, the ONLY honest
 * answer is the disclaimer path, never a repurposed write tool.
 *
 * ## The predicate: argument provenance, not intent
 *
 * Matching a tool's description against the user's ask is a semantic judgement
 * no validator can make (and an LLM judge inside the create loop would be both
 * slow and unfalsifiable). The discriminator that mechanically separates the
 * two measured cases is where the call's OPERANDS came from:
 *
 * - FAIL — the Slack case: the operands that name the effect's TARGET and its
 *   MAGNITUDE are hand-typed into the source (`recipient_name: 'Slack
 *   Forwarding Bot'`, `amount: 1`). Nothing chose them: not the user, not a
 *   tool, not a row. They are fabricated, exactly like the hand-typed business
 *   data law 1 already rejects in `literals.ts` — this is that principle
 *   applied to a mutating call's operands.
 * - PASS — the Cadence case (`let me chase every overdue invoice in one go`):
 *   `tools.host_sendClientMessage({ id: selectedId, body: { body, author:
 *   "Firm" } })`. The target is a selected client id and the payload is form
 *   state; both arrive through identifiers. Correct behaviour, and it must
 *   stay correct.
 *
 * So: a MUTATING tool invoked with a hand-typed literal in a TARGET or AMOUNT
 * operand, where that literal is not a value the user themselves named and not
 * a closed vocabulary the tool declares, is capability substitution.
 *
 * ## Deliberate narrowness (measured: 12/12 legitimate calls in the 2026-07-27
 *    corpus pass, both substitution cases fail)
 *
 * - **Only target/amount keys.** CONTENT keys (memo, body, message, note,
 *   subject) are excluded: a canned reminder body is legitimate copy, and the
 *   PASS case hand-types `author: "Firm"`. The target and the magnitude are
 *   what make an effect land somewhere it was never chosen to land.
 * - **Only entity-reference target words.** `id`, `recipient`, `payee`,
 *   `beneficiary`, `destination`, `to`, `email`, `phone`, `address` — words
 *   that ARE a reference to an entity. Generic nouns that also modify config
 *   keys (`accountType`, `clientFilter`, `invoiceStatus`) are out.
 * - **Enums, booleans, and consts never trip it.** A status enum, a flag, a
 *   lifecycle action are config by construction.
 * - **The user's own values never trip it.** "Send $25 to Alex Rivera"
 *   legitimately compiles to `{amount: 2500, recipient_name: "Alex Rivera"}` —
 *   both are in the request text (numbers via the same
 *   {@link requestNumberValues} carve-out law 1 uses for island math). A real
 *   corpus app does exactly this.
 * - **No exempt magnitudes.** Unlike display math, `1` is not unit scaling in
 *   a transfer amount — it is the live defect's sentinel value.
 *
 * Both surfaces are covered: `{action, payload}` bindings in the tree (via
 * actions.ts's shared walker) and literal `tools.<name>(…)` calls in island
 * source, so the declarative path is not a loophole.
 */
import {
  blankNonCode,
  isPathBinding,
  isStateBinding,
  requestNumberValues,
  type Tree,
} from "@vendoai/core";
import type { HostToolInfo } from "../engine.js";
import { actionBindingsInProps, isMutatingRisk } from "./actions.js";
import { DISCLAIMER_TEXT } from "./disclaimer.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Which operand names carry the target or the magnitude of an effect
// ---------------------------------------------------------------------------

/** Words that ARE a reference to the entity an effect lands on. `id` covers
 *  every `clientId` / `docId` / `invoice_id` by word split. */
const TARGET_WORDS: ReadonlySet<string> = new Set([
  "id", "ids", "recipient", "payee", "beneficiary", "destination", "to",
  "email", "phone", "address",
]);

/** Words that carry how much an effect moves. */
const AMOUNT_WORDS: ReadonlySet<string> = new Set([
  "amount", "amounts", "cents", "dollars", "total", "price", "quantity", "qty", "balance",
]);

/** camelCase / snake_case / kebab-case → lowercased words. `recipient_name` →
 *  ["recipient","name"]; `accountType` → ["account","type"]; `identifier` →
 *  ["identifier"] (never a false "id" hit). */
const keyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");

const isEffectOperandKey = (key: string): boolean =>
  keyWords(key).some((word) => TARGET_WORDS.has(word) || AMOUNT_WORDS.has(word));

// ---------------------------------------------------------------------------
// The shared predicate over one call's arguments
// ---------------------------------------------------------------------------

/** One argument value, normalized so the tree payload and island source share
 *  ONE predicate. `other` is anything that reaches the call through a
 *  reference — an identifier, a member path, a binding, a call, a
 *  concatenation, a ternary: data someone or something else chose. */
type ArgValue =
  | { kind: "literal"; text: string; value: string | number }
  | { kind: "object"; entries: Array<readonly [string, ArgValue]> }
  | { kind: "other" };

export interface FabricatedOperand {
  /** Dotted argument path — `recipient_name`, `body.clientId`. */
  path: string;
  /** The hand-typed value as written, for the repair message. */
  literal: string;
}

const propertySchema = (schema: unknown, key: string): unknown =>
  isRecord(schema) && isRecord(schema.properties) ? schema.properties[key] : undefined;

/** A parameter the tool declares as a closed vocabulary or a flag — config by
 *  construction, never the identity of an effect's target. */
const isClosedVocabulary = (schema: unknown): boolean =>
  isRecord(schema) && (Array.isArray(schema.enum) || schema.const !== undefined || schema.type === "boolean");

/** A value the USER named in their own request is their parameter, not a
 *  fabrication (the same carve-out law 1 makes for island math). Numbers match
 *  the request's numbers and their cent-scaled forms; strings match by
 *  containment, so "alex" satisfies "pay Alex Rivera". */
const userSupplied = (value: string | number, numbers: ReadonlySet<number>, requestText: string | undefined): boolean => {
  if (typeof value === "number") return numbers.has(Math.abs(value));
  const needle = value.trim().toLowerCase();
  if (needle.length < 2) return true;
  if (/^\d+$/.test(needle) && numbers.has(Number(needle))) return true;
  return requestText !== undefined && requestText.toLowerCase().includes(needle);
};

const collectOperands = (
  value: ArgValue,
  schema: unknown,
  path: readonly string[],
  numbers: ReadonlySet<number>,
  requestText: string | undefined,
  found: FabricatedOperand[],
): void => {
  if (value.kind === "object") {
    for (const [key, child] of value.entries) {
      collectOperands(child, propertySchema(schema, key), [...path, key], numbers, requestText, found);
    }
    return;
  }
  if (value.kind !== "literal") return;
  const key = path[path.length - 1];
  if (key === undefined || !isEffectOperandKey(key)) return;
  if (isClosedVocabulary(schema)) return;
  if (userSupplied(value.value, numbers, requestText)) return;
  found.push({ path: path.join("."), literal: value.text });
};

/** The hand-typed target/amount operands of one mutating call. Empty means the
 *  call's effect is grounded in something the user or a tool chose. */
const fabricatedOperands = (
  args: ArgValue,
  tool: HostToolInfo,
  requestText: string | undefined,
): FabricatedOperand[] => {
  const found: FabricatedOperand[] = [];
  const numbers = requestText === undefined ? new Set<number>() : requestNumberValues(requestText);
  collectOperands(args, tool.inputSchema, [], numbers, requestText, found);
  return found;
};

/** The one repair-facing message, shared by both surfaces: name the fabricated
 *  operands, name the real cause (the host lacks the capability), and name the
 *  only honest answer. `lead` is the caller's clause up to the verb. */
const substitutionMessage = (lead: string, toolName: string, operands: readonly FabricatedOperand[]): string =>
  `${lead} MUTATING tool "${toolName}" with hand-typed operand(s) ${operands.map(({ path, literal }) => `${path}=${literal}`).join(", ")} — a write tool's TARGET and AMOUNT must come from tool data, the user's own input, or the row the user acted on. Hand-typing them means this tool is being REPURPOSED to fake a capability this host does not have (sending money to deliver a message is a real side effect, not a workaround). The host lacks the tool this part of the ask needs: drop the call and say so — render an honest <Disclaimer reason="..."/> or text stating "${DISCLAIMER_TEXT}". Never substitute an unrelated write tool.`;

// ---------------------------------------------------------------------------
// Surface 1 — declarative {action, payload} bindings in the tree
// ---------------------------------------------------------------------------

const treeArgValue = (value: unknown): ArgValue => {
  if (typeof value === "string") return { kind: "literal", text: JSON.stringify(value), value };
  if (typeof value === "number") return { kind: "literal", text: String(value), value };
  if (isRecord(value)) {
    // A binding is data the compiler fetches — provenance by construction.
    if (isPathBinding(value) || isStateBinding(value)) return { kind: "other" };
    return { kind: "object", entries: Object.entries(value).map(([key, child]) => [key, treeArgValue(child)] as const) };
  }
  return { kind: "other" };
};

/** The capability-substitution issues of a compiled tree's action payloads. */
export const capabilitySubstitutionIssues = (
  tree: Tree,
  tools: readonly HostToolInfo[] | undefined,
  requestText?: string,
): string[] => {
  const byName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
  if (byName.size === 0) return [];
  const issues: string[] = [];
  for (const node of tree.nodes) {
    if (node.props === undefined) continue;
    for (const { prop, action, payload } of actionBindingsInProps(node.props)) {
      const tool = byName.get(action);
      if (tool === undefined || !isMutatingRisk(tool.risk)) continue;
      const operands = fabricatedOperands(treeArgValue(payload), tool, requestText);
      if (operands.length === 0) continue;
      issues.push(substitutionMessage(`node "${node.id}" prop "${prop}" invokes`, action, operands));
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// Surface 2 — literal `tools.<name>(…)` calls in island source
// ---------------------------------------------------------------------------

/** Forward-match a bracket to its partner over the code-only view. */
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

/** Top-level `,`-separated member spans of an object literal, over the
 *  code-only view (so delimiters inside strings never miscount). */
const objectEntrySpans = (code: string, open: number, close: number): Array<{ start: number; end: number }> => {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const char = code[index] as string;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      spans.push({ start, end: index });
      start = index + 1;
    }
  }
  spans.push({ start, end: close });
  return spans;
};

/** The colon separating an object member's key from its value, at depth 0. */
const keyValueSplit = (code: string, start: number, end: number): number => {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = code[index] as string;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) return index;
  }
  return -1;
};

/** Strip balanced wrapping parens: `(1)` is the same hand-typed operand as `1`. */
const unwrapParens = (text: string): string => {
  let inner = text;
  while (inner.startsWith("(") && inner.endsWith(")")) {
    const stripped = inner.slice(1, -1);
    let depth = 0;
    for (const char of stripped) {
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (depth < 0) return inner;
    }
    if (depth !== 0) return inner;
    inner = stripped.trim();
  }
  return inner;
};

// The core of a hand-typed number once its wrappers are peeled: decimal,
// hex/octal/binary, exponent, numeric separators. `0x1` is `1` wearing a hat,
// and a gate that reads only `1` is a gate with a published bypass. Loose by
// design — the Number() round-trip below rejects whatever this lets through.
const NUMERIC_CORE =
  /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)$/;

/**
 * A hand-typed number in ANY spelling, or undefined if the span is a reference.
 *
 * Peels the syntax that can wrap a bare number without making it anything else
 * — parens, unary signs, and TS type assertions (island source is TSX, so
 * `1 as const` is legal) — in any order, with any spacing, then tests the
 * core. Peeling in a loop rather than matching one big pattern is what closes
 * the class: `+ 1`, `-(1)`, `( + 0x1 )` and `1 as number` are the same
 * fabricated operand as `1`, and enumerating spellings would leave the next
 * combination open. A mis-peel is harmless — whatever it yields still has to
 * pass the core test, so the failure mode is "reads as a reference", which is
 * the behaviour without any peeling at all.
 */
const numericLiteral = (blanked: string): { text: string; value: number } | undefined => {
  let inner = blanked.trim();
  let negative = false;
  for (;;) {
    const unwrapped = unwrapParens(inner);
    const signed = /^([+-])\s*([\s\S]*)$/.exec(unwrapped);
    if (signed !== null) {
      if (signed[1] === "-") negative = !negative;
      inner = (signed[2] as string).trim();
      continue;
    }
    // `x as T` / `x satisfies T`, one assertion per pass so chains unwind.
    const asserted = /^([\s\S]+?)\s+(?:as|satisfies)\s+[\w$][\w$.<>[\]|&, ]*$/.exec(unwrapped);
    if (asserted !== null) {
      inner = (asserted[1] as string).trim();
      continue;
    }
    inner = unwrapped;
    break;
  }
  if (!NUMERIC_CORE.test(inner)) return undefined;
  const magnitude = Number(inner.replace(/_/g, ""));
  if (!Number.isFinite(magnitude)) return undefined;
  // `text` quotes what the model actually typed, so repair sees its own token.
  return { text: blanked.trim(), value: negative ? -magnitude : magnitude };
};

/**
 * Classify one island-source value span. `code` is {@link blankNonCode}'s
 * offset-preserving view, where a string literal keeps its delimiters and
 * loses its contents — so `'Slack Forwarding Bot'` reads as `'…spaces…'` (one
 * literal, nothing else) while `'A: ' + summary` still shows the reference.
 * That is the whole literal-vs-reference test; the VALUE is then read from the
 * original source at the same offsets.
 */
const sourceArgValue = (source: string, code: string, start: number, end: number): ArgValue => {
  let from = start;
  while (from < end && /\s/.test(code[from] as string)) from += 1;
  let to = end;
  while (to > from && /\s/.test(code[to - 1] as string)) to -= 1;
  if (to <= from) return { kind: "other" };
  const blanked = code.slice(from, to);
  const raw = source.slice(from, to);
  if (blanked.startsWith("{") && matchForward(code, from) === to - 1) {
    return {
      kind: "object",
      entries: objectMembers(source, code, from, to - 1),
    };
  }
  const numeric = numericLiteral(blanked);
  if (numeric !== undefined) return { kind: "literal", ...numeric };
  // A lone string/static-template literal: delimiters with only blanked text
  // between them. Concatenation or interpolation leaves code behind and falls
  // through to `other`.
  if (/^(["'`])\s*\1$/.test(blanked)) {
    const value = raw.slice(1, -1);
    return { kind: "literal", text: JSON.stringify(value), value };
  }
  return { kind: "other" };
};

const objectMembers = (
  source: string,
  code: string,
  open: number,
  close: number,
): Array<readonly [string, ArgValue]> => {
  const entries: Array<readonly [string, ArgValue]> = [];
  for (const { start, end } of objectEntrySpans(code, open, close)) {
    const colon = keyValueSplit(code, start, end);
    // No colon = shorthand (`{ body }`) or a spread — a reference either way.
    if (colon === -1) continue;
    const key = /^\s*(?:(["'])([^"']*)\1|([A-Za-z_$][\w$]*))\s*$/.exec(source.slice(start, colon));
    // A computed key (`[field]:`) names no declared parameter.
    if (key === null) continue;
    entries.push([(key[2] ?? key[3]) as string, sourceArgValue(source, code, colon + 1, end)]);
  }
  return entries;
};

const TOOL_CALL = /\btools\s*\.\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;

/** The capability-substitution violations of one island's source. Prefixed by
 *  the caller with `island "<name>" ` (islands.ts's convention). */
export const islandSubstitutionViolations = (
  source: string,
  tools: readonly HostToolInfo[] | undefined,
  requestText?: string,
): string[] => {
  const byName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
  if (byName.size === 0) return [];
  const code = blankNonCode(source);
  const violations: string[] = [];
  const reported = new Set<string>();
  for (const match of code.matchAll(TOOL_CALL)) {
    const toolName = (match[1] as string).replace(/\s*\.\s*/g, "_");
    const tool = byName.get(toolName);
    if (tool === undefined || !isMutatingRisk(tool.risk)) continue;
    const open = match.index + match[0].length - 1;
    const args = sourceArgValue(source, code, open + 1, matchForward(code, open));
    const operands = fabricatedOperands(args, tool, requestText);
    if (operands.length === 0) continue;
    const key = `${toolName}:${operands.map(({ path, literal }) => `${path}=${literal}`).join(",")}`;
    if (reported.has(key)) continue;
    reported.add(key);
    violations.push(substitutionMessage("calls", toolName, operands));
  }
  return violations;
};
