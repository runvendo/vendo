import { VENDO_TREE_FORMAT } from "@vendoai/core";
import type { Json, Tree, TreeNode, TreeQuery } from "@vendoai/core";
import { canonicalize } from "./canonicalize.js";

/**
 * Candidate B — VTL ("Vendo Tree Lines"), an aggressive line-oriented DSL.
 *
 * One line per thing, opcode as the first character, structural punctuation
 * stripped to almost nothing. This is the "~65% savings" shape the Monogram
 * research credits — but adapted to a hard truth about our format: the tree is a
 * **flat graph** (shared children, cycles, orphans, dangling ids all legal), so
 * VTL is deliberately NOT an indentation-nests-children DSL. Nesting cannot
 * represent a DAG without duplicating shared nodes (lossy) or inventing a
 * reference syntax (no simpler than ids). VTL keeps the flat node list and lists
 * children by id — the savings come from dropping keys/braces/quotes, not nesting.
 *
 * Grammar (lines joined by "\n"):
 *   line 0        `vtl1 <rootTok>`
 *   node          `-<idTok> <sig><compTok>[\t<props?>[\t<childTok ...>]]`
 *   data          `D\t<JSON object>`
 *   query         `Q\t<JSON [path, tool]  |  [path, tool, input]>`
 *   component     `C\t<JSON [name, source]>`   (source's newlines ride inside the JSON string)
 * `<sig>` ∈ { '.' prewired, ':' host, '*' generated }; absent when source is unset.
 *
 * TOKENS — full coverage of the legal format range. `validateTree` allows ids
 * and component names to contain whitespace, quotes, or sigil-leading characters
 * (and child ids may even be empty strings), so raw emission alone cannot cover
 * the format. A token is therefore either:
 *   - RAW: emitted verbatim; allowed only when non-empty, free of space/tab/
 *     newline, and not starting with `"`; or
 *   - ESCAPED: a JSON string literal with every literal space additionally
 *     escaped as ` ` (JSON already escapes tab/newline), so an escaped
 *     token contains NO structural whitespace at all. A token starting with `"`
 *     is unambiguously escaped.
 * A component token is additionally force-escaped when the node has no source
 * and the name starts with a sigil character (else a component named `.Foo`
 * would misdecode as prewired `Foo`), and whenever it starts with `"`. Every
 * validateTree-legal id/component/source combination round-trips; the property
 * tests generate hostile ids/components to police exactly this.
 *
 * Optional-field disambiguation on a node line, by tab count:
 *   0 tabs                       → no props, no children
 *   1 tab,  segment is `{...}`   → props present (incl. `{}`), no children
 *   2 tabs, seg1 `""`|`{...}`    → props absent (empty seg) vs present; seg2 is the
 *                                  space-joined child tokens (`""` = empty children [])
 * A literal TAB can never appear inside a JSON string (JSON escapes it), so
 * tab-splitting is collision-free and escaping-hostile prop VALUES cost zero
 * extra escaping — JSON already owns their quoting.
 *
 * The DECODER IS STRICT — it is the validity oracle for the live emission
 * measurement, so anything off-grammar throws: wrong header, extra tab segments,
 * malformed heads/tokens, non-object props/data, wrong query/component tuple
 * shapes, duplicate D lines or C names, unknown opcodes. (Duplicate node ids and
 * the caps are the tree validator's job — parseArm runs validateTree on every
 * decode, so those still count as invalid in the measurement.)
 *
 * Lossless: `decodeVtl(encodeVtl(t))` deep-equals `canonicalize(t)`.
 */

const SIG: Record<NonNullable<TreeNode["source"]>, string> = {
  prewired: ".",
  host: ":",
  generated: "*",
};
const SIG_NAME: Record<string, TreeNode["source"]> = {
  ".": "prewired",
  ":": "host",
  "*": "generated",
};

const VTL_HEADER = "vtl1 ";
const STRUCTURAL = /[ \t\n]/;

/** Escape into a JSON string literal with literal spaces also escaped, so the
 *  token carries no structural whitespace at all. */
function escapeToken(value: string): string {
  return JSON.stringify(value).replaceAll(" ", "\\u0020");
}

/** Encode a token: raw when safe, else escaped. */
function encodeToken(value: string): string {
  if (value.length > 0 && !STRUCTURAL.test(value) && value[0] !== '"') return value;
  return escapeToken(value);
}

function decodeToken(token: string, label: string): string {
  if (token.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new Error(`vtl: malformed escaped ${label} token ${JSON.stringify(token)}`);
    }
    if (typeof parsed !== "string") throw new Error(`vtl: escaped ${label} token is not a string`);
    return parsed;
  }
  if (token.length === 0) throw new Error(`vtl: empty ${label} token`);
  if (STRUCTURAL.test(token)) throw new Error(`vtl: raw ${label} token contains structural whitespace`);
  return token;
}

const isPlainObject = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function encodeVtl(input: unknown): string {
  const tree = canonicalize(input);
  const lines: string[] = [`${VTL_HEADER}${encodeToken(tree.root)}`];

  for (const node of tree.nodes) {
    const idTok = encodeToken(node.id);
    const sig = node.source ? SIG[node.source] : "";
    // Force-escape a sourceless component whose first char collides with the
    // sigil alphabet — `.Foo` with no source must not decode as prewired Foo —
    // and any component starting with `"` (would misparse as an escaped token).
    const forceEscape =
      node.source === undefined &&
      (node.component[0] === "." || node.component[0] === ":" || node.component[0] === "*");
    const compTok = forceEscape ? escapeToken(node.component) : encodeToken(node.component);
    const head = `-${idTok} ${sig}${compTok}`;

    const hasProps = node.props !== undefined;
    const hasChildren = node.children !== undefined;
    if (hasChildren) {
      const children = node.children!.map((c) => encodeToken(c)).join(" ");
      lines.push(`${head}\t${hasProps ? JSON.stringify(node.props) : ""}\t${children}`);
    } else if (hasProps) {
      lines.push(`${head}\t${JSON.stringify(node.props)}`);
    } else {
      lines.push(head);
    }
  }

  if (tree.data !== undefined) lines.push(`D\t${JSON.stringify(tree.data)}`);
  if (tree.queries !== undefined) {
    for (const q of tree.queries) {
      lines.push(`Q\t${JSON.stringify(q.input !== undefined ? [q.path, q.tool, q.input] : [q.path, q.tool])}`);
    }
  }
  if (tree.components !== undefined) {
    for (const [name, source] of Object.entries(tree.components)) {
      lines.push(`C\t${JSON.stringify([name, source])}`);
    }
  }
  return lines.join("\n");
}

export function decodeVtl(wire: string): Tree {
  const lines = wire.split("\n");
  if (lines.length === 0 || !lines[0]!.startsWith(VTL_HEADER)) {
    throw new Error("vtl: missing or malformed header line (expected `vtl1 <root>`)");
  }
  const rootRaw = lines[0]!.slice(VTL_HEADER.length);
  if (rootRaw.includes(" ") || rootRaw.includes("\t")) {
    throw new Error("vtl: header carries more than one token");
  }
  const root = decodeToken(rootRaw, "root");

  const nodes: TreeNode[] = [];
  let data: Record<string, Json> | undefined;
  const queries: TreeQuery[] = [];
  const components: Record<string, string> = {};

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const opcode = line[0];
    if (opcode === "-") {
      nodes.push(decodeNodeLine(line, i));
    } else if (opcode === "D") {
      if (line[1] !== "\t") throw new Error(`vtl line ${i}: D must be followed by a tab`);
      if (data !== undefined) throw new Error(`vtl line ${i}: duplicate D (data) line`);
      const parsed: unknown = JSON.parse(line.slice(2));
      if (!isPlainObject(parsed)) throw new Error(`vtl line ${i}: data payload must be a JSON object`);
      data = parsed;
    } else if (opcode === "Q") {
      if (line[1] !== "\t") throw new Error(`vtl line ${i}: Q must be followed by a tab`);
      const tuple: unknown = JSON.parse(line.slice(2));
      if (
        !Array.isArray(tuple) ||
        tuple.length < 2 ||
        tuple.length > 3 ||
        typeof tuple[0] !== "string" ||
        typeof tuple[1] !== "string" ||
        (tuple.length === 3 && !isPlainObject(tuple[2]))
      ) {
        throw new Error(`vtl line ${i}: query must be [path, tool] or [path, tool, inputObject]`);
      }
      const query: TreeQuery = { path: tuple[0] as string, tool: tuple[1] as string };
      if (tuple.length === 3) query.input = tuple[2] as Record<string, Json>;
      queries.push(query);
    } else if (opcode === "C") {
      if (line[1] !== "\t") throw new Error(`vtl line ${i}: C must be followed by a tab`);
      const tuple: unknown = JSON.parse(line.slice(2));
      if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || typeof tuple[1] !== "string") {
        throw new Error(`vtl line ${i}: component must be [name, source] (two strings)`);
      }
      const [name, source] = tuple as [string, string];
      if (Object.prototype.hasOwnProperty.call(components, name)) {
        throw new Error(`vtl line ${i}: duplicate component ${JSON.stringify(name)}`);
      }
      components[name] = source;
    } else {
      throw new Error(`vtl line ${i}: unrecognized opcode ${JSON.stringify(String(opcode))}`);
    }
  }

  const tree: Tree = { formatVersion: VENDO_TREE_FORMAT, root, nodes };
  if (data !== undefined) tree.data = data;
  if (queries.length > 0) tree.queries = queries;
  if (Object.keys(components).length > 0) tree.components = components;
  return tree;
}

function decodeNodeLine(line: string, lineNo: number): TreeNode {
  const parts = line.split("\t");
  if (parts.length > 3) {
    throw new Error(`vtl line ${lineNo}: too many tab segments on a node line (max 3)`);
  }
  const head = parts[0]!;
  const sp = head.indexOf(" ");
  if (sp < 2) throw new Error(`vtl line ${lineNo}: node head must be \`-<id> <component>\``);
  const id = decodeToken(head.slice(1, sp), "node id");
  let compTok = head.slice(sp + 1);
  if (compTok.length === 0) throw new Error(`vtl line ${lineNo}: missing component token`);
  if (compTok.includes(" ")) throw new Error(`vtl line ${lineNo}: node head carries more than two tokens`);

  const node: TreeNode = { id, component: "" };
  const sigil = compTok[0]!;
  if (sigil === "." || sigil === ":" || sigil === "*") {
    node.source = SIG_NAME[sigil];
    compTok = compTok.slice(1);
    if (compTok.length === 0) throw new Error(`vtl line ${lineNo}: sigil with no component token`);
  }
  node.component = decodeToken(compTok, "component");

  if (parts.length >= 2 && parts[1] !== "") {
    const parsed: unknown = JSON.parse(parts[1]!);
    if (!isPlainObject(parsed)) throw new Error(`vtl line ${lineNo}: props segment must be a JSON object`);
    node.props = parsed;
  }
  if (parts.length === 2 && parts[1] === "") {
    throw new Error(`vtl line ${lineNo}: dangling empty props segment (children segment missing)`);
  }
  if (parts.length === 3) {
    node.children = parts[2] === "" ? [] : parts[2]!.split(" ").map((tok) => decodeToken(tok, "child id"));
  }
  return node;
}
