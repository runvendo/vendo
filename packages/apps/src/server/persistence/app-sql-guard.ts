/**
 * The door. Everything an app's SQL is allowed to say, and the ONE place
 * `mine.` becomes one person's rows.
 *
 * Generated SQL is HOSTILE INPUT. What keeps one person out of another's rows
 * is not anything the model writes, and not a privilege of the host's database
 * either — a BYO Postgres url is very often a superuser, and a fence that
 * evaporates when the operator's role is too strong is not a fence. So the
 * fence is NAME RESOLUTION, in four layers:
 *
 *   1. `mine.x` and `shared.x` are the only table addresses that exist. They
 *      become physical names carrying a ":" — a character no identifier this
 *      grammar admits can contain — so a physical table has no spelling inside
 *      an app's SQL, and one person's tables have no spelling in another's.
 *   2. Unqualified names resolve inside the app's own namespace and nowhere
 *      else (the adapter's half), so a name that somehow got past layer 1 still
 *      cannot leave the app.
 *   3. Any qualifier that is not `mine`/`shared` is handed back to the caller,
 *      which refuses it when the database says it names a real schema. Table
 *      aliases pass; `public.vendo_records` does not.
 *   4. ONE statement, from a short allowlist, with no session, role, schema or
 *      catalog verb anywhere in it.
 *
 * Anything this file cannot account for is REFUSED, never guessed at.
 */
import { VendoError, type RiskLabel } from "@vendoai/core";

/** What a statement DOES, graded before it runs, so a running app's SELECT can
    take the query arm the ui kit's `useToolQuery` needs. Pessimistic on
    purpose: it reads the raw text (a keyword inside a string counts), because
    over-grading costs an approval card and under-grading costs a silent write.
    Cheap and total — it never throws, and the guard proper still runs after. */
export const sqlRisk = (sql: string): RiskLabel => {
  if (/\bdrop\b/i.test(sql)) return "destructive";
  if (/\b(insert|update|delete|create|alter|truncate)\b/i.test(sql)) return "write";
  return /^\s*(select|with)\b/i.test(sql) ? "read" : "write";
};

/** How a table or column name may be spelled. Short because the physical name
    it becomes must fit Postgres' 63-byte identifier limit with room to spare
    for the names a PRIMARY KEY, a UNIQUE or a `serial` derives from it. */
const NAME = /^[a-z][a-z0-9_]{0,27}$/;

/** Identifier families the app never needs and an attacker always wants:
    Postgres' catalog and its file / large-object verbs, SQLite's catalog, and
    this module's own bookkeeping. */
const DENIED_PREFIX = /^(pg_|lo_|sqlite_|_vendo)/;

/** Names that read a file, open a connection, or run SQL of their own — plus
    the one DDL word that would collide across people. */
const DENIED_WORDS = new Set([
  "information_schema", "dblink", "dblink_exec", "set_config", "current_setting",
  "xmltable", "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
  "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
  "cursor_to_xml", "cursor_to_xmlschema",
  "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
  "load_extension", "readfile", "writefile", "fts3_tokenizer", "zipfile",
  // A named constraint's backing index is named per-namespace, and a `mine.`
  // table is one per person: the second person to replay the same CREATE would
  // collide with the first. An anonymous constraint is named off its table,
  // which already differs per person.
  "constraint",
]);

/** The statement heads an app's database accepts. */
const HEADS = [
  ["create", "table"], ["alter", "table"], ["drop", "table"],
  ["select"], ["with"], ["insert"], ["update"], ["delete"],
] as const;

/** What ALTER TABLE may go on to say. Everything else — SET SCHEMA, OWNER TO,
    ENABLE TRIGGER, ROW LEVEL SECURITY — changes how the table is fenced, which
    belongs to the app's database and not to the app. */
const ALTER_VERBS = new Set(["add", "drop", "rename", "alter"]);

/** Words that may stand between `CREATE/ALTER/DROP TABLE` and its target. */
const BEFORE_TARGET = new Set(["if", "not", "exists", "only"]);

type Kind = "word" | "quoted" | "name" | "param" | "text";
interface Token { kind: Kind; text: string; word: string }

export interface GuardedSql {
  /** The statement with every `mine.`/`shared.` address replaced by its
      physical name, and `?` markers spelled for the dialect. */
  sql: string;
  /** Changes the app's schema. When it also touches `mine.`, it is recorded in
      the app's DDL log and replayed for everyone else who opens the app. */
  ddl: boolean;
  /** Touches at least one `mine.` table. */
  mine: boolean;
  /** Every qualifier that was neither `mine` nor `shared` — aliases, unless the
      database says one of them is a schema, which the caller checks. */
  qualifiers: string[];
}

const refuse = (message: string): never => {
  throw new VendoError("validation", message);
};

/** what happened · why · fix — the sentence a table with no namespace earns. */
export const unnamespaced = (name: string): never => refuse(
  `"${name}" is not a table this app can reach. Every table lives in shared. (all users) or mine. (per-user). `
  + `Did you mean mine.${name}?`,
);

/** The physical name of a table. The ":" is the fence: no name the grammar
    above admits can contain one, so these are unwritable from inside an app's
    SQL and unguessable across people. */
export const sharedTable = (name: string): string => `s:${name}`;
export const mineTable = (owner: string, name: string): string => `m:${owner}:${name}`;

/** What a recorded DDL statement carries where the owner's digest goes, so one
    recorded statement replays for everybody. */
const OWNER_SLOT = "{}";

export const templateOf = (sql: string, owner: string): string => sql.split(`m:${owner}:`).join(`m:${OWNER_SLOT}:`);
export const replayFor = (template: string, owner: string): string => template.split(`m:${OWNER_SLOT}:`).join(`m:${owner}:`);

const IDENT_START = /[A-Za-z_-￿]/;
const IDENT_PART = /[A-Za-z0-9_-￿]/;

/** Where a `'…'` or `"…"` run ends, doubling counting as an escape. One scanner
    for both quotes: they differ only in the character. */
function endOfQuoted(sql: string, from: number, quote: string, what: string): number {
  let j = from + 1;
  for (;;) {
    const at = sql.indexOf(quote, j);
    if (at === -1) refuse(`The statement ends inside ${what}. Close the quote and send it again.`);
    if (sql[at + 1] === quote) { j = at + 2; continue; }
    return at + 1;
  }
}

/** Where a `--` or `/* *&#47;` comment ends. Comments become one space, so
    nothing they hide can reach any rule below. */
function endOfComment(sql: string, from: number): number | undefined {
  if (sql[from] === "-" && sql[from + 1] === "-") {
    const end = sql.indexOf("\n", from);
    return end === -1 ? sql.length : end;
  }
  if (sql[from] !== "/" || sql[from + 1] !== "*") return undefined;
  const end = sql.indexOf("*/", from + 2);
  if (end === -1) refuse("The statement ends inside a /* comment. Close the comment and send it again.");
  return end + 2;
}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const push = (kind: Kind, text: string, word = ""): number => out.push({ kind, text, word });
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) { push("text", " "); i += 1; continue; }
    const comment = endOfComment(sql, i);
    if (comment !== undefined) { i = comment; push("text", " "); continue; }
    if (c === "'") {
      const j = endOfQuoted(sql, i, "'", "a '…' string");
      push("text", sql.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"') {
      const j = endOfQuoted(sql, i, '"', 'a "…" quoted name');
      const inner = sql.slice(i + 1, j - 1).replace(/""/g, '"').toLowerCase();
      if (!NAME.test(inner)) {
        refuse(
          `"${inner}" is not a name this app can use. A name is a letter followed by letters, digits or underscores, `
          + "up to 28 characters. Rename it and send the statement again.",
        );
      }
      push("quoted", `"${inner}"`, inner);
      i = j;
      continue;
    }
    if (c === "`" || c === "[") {
      refuse(`${c} is not a way to quote a name here. Use "double quotes", or no quotes at all.`);
    }
    if (c === "$") {
      refuse("Dollar signs are not accepted in a statement. Use `?` for a parameter and '…' for a string.");
    }
    if (c === "?") { push("param", "?"); i += 1; continue; }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && IDENT_PART.test(sql[j] as string)) j += 1;
      const text = sql.slice(i, j);
      const word = text.toLowerCase();
      if (DENIED_PREFIX.test(word) || DENIED_WORDS.has(word)) {
        refuse(
          `"${text}" is reserved. The app's database keeps its own bookkeeping and the server's catalog out of reach, `
          + "so names in those families are refused. Use a different name.",
        );
      }
      push("word", text, word);
      i = j;
      continue;
    }
    push("text", c);
    i += 1;
  }
  return out;
}

/** Turn every `mine.x` / `shared.x` into ONE physical name token, in place, and
    hand back what the caller has to know: whether the statement touches a
    `mine.` table, and every OTHER qualifier it used — an alias, unless the
    database says one of them is a schema, which the caller checks. */
function rewriteNamespaces(
  tokens: Token[],
  owner: string,
  solid: (from: number) => number,
): { mine: boolean; qualifiers: string[] } {
  const qualifiers = new Set<string>();
  let mine = false;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as Token;
    if (token.kind !== "word" && token.kind !== "quoted") continue;
    const dotAt = solid(at + 1);
    if (dotAt === -1 || (tokens[dotAt] as Token).text !== ".") {
      if (token.kind === "word" && (token.word === "mine" || token.word === "shared")) {
        refuse(
          `"${token.text}" names one of this app's two table namespaces and cannot stand on its own. `
          + `Write ${token.word}.<table>.`,
        );
      }
      continue;
    }
    const nameAt = solid(dotAt + 1);
    const name = nameAt === -1 ? undefined : tokens[nameAt] as Token;
    if (name === undefined || (name.kind !== "word" && name.kind !== "quoted")) {
      refuse(`"${token.text}." is not followed by a name. Write ${token.word}.<table>.`);
      throw new Error("unreachable");
    }
    const thirdAt = solid(nameAt + 1);
    if (thirdAt !== -1 && (tokens[thirdAt] as Token).text === ".") {
      refuse(`"${token.text}.${name.word}.…" has three parts. A table is shared.<table> or mine.<table>, nothing else.`);
    }
    if (token.kind === "quoted" || (token.word !== "mine" && token.word !== "shared")) {
      qualifiers.add(token.word);
      at = nameAt;
      continue;
    }
    if (!NAME.test(name.word)) {
      refuse(
        `"${name.word}" is not a table name this app can use. A table name is a letter followed by letters, digits `
        + "or underscores, up to 28 characters.",
      );
    }
    if (token.word === "mine") mine = true;
    const physical = token.word === "mine" ? mineTable(owner, name.word) : sharedTable(name.word);
    token.kind = "name";
    token.word = physical;
    token.text = `"${physical}"`;
    for (let blank = at + 1; blank <= nameAt; blank += 1) (tokens[blank] as Token).text = "";
    at = nameAt;
  }
  return { mine, qualifiers: [...qualifiers] };
}

/** The statement, guarded and rewritten for ONE person. Throws with
    what·why·fix on anything it will not run. */
export function guardSql(sql: string, owner: string, dialect: "postgres" | "sqlite"): GuardedSql {
  if (sql.trim() === "") {
    refuse("The statement is empty. Send one SQL statement — for example `SELECT * FROM mine.notes`.");
  }
  const tokens = tokenize(sql);
  const solid = (from: number): number => {
    for (let at = from; at < tokens.length; at += 1) {
      if ((tokens[at] as Token).text.trim() !== "") return at;
    }
    return -1;
  };

  // --- ONE statement. A ";" with anything after it is a second statement
  //     riding the first, which is how every rule below gets skipped. Checked
  //     on TOKENS, so a ";" inside a string is just a character.
  const solidTokens = tokens.filter((token) => token.text.trim() !== "");
  if (solidTokens.some((token, index) => token.text === ";" && index !== solidTokens.length - 1)) {
    refuse("Send ONE statement at a time. This one holds a `;` with more after it — split it into separate calls.");
  }

  // --- The statement head.
  const lead: Token[] = [];
  for (let at = solid(0); at !== -1 && lead.length < 2; at = solid(at + 1)) lead.push(tokens[at] as Token);
  const head = HEADS.find((candidate) => candidate.every((part, index) => lead[index]?.word === part));
  if (head === undefined) {
    refuse(
      `"${lead.map((token) => token.text).join(" ") || sql.trim()}" is not something an app's database does. `
      + "It runs one of SELECT, WITH, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE or DROP TABLE. "
      + "Rewrite the statement as one of those.",
    );
    throw new Error("unreachable");
  }
  const ddl = head[0] === "create" || head[0] === "alter" || head[0] === "drop";

  const { mine, qualifiers } = rewriteNamespaces(tokens, owner, solid);

  // --- A DDL target has to be one of ours, or `CREATE TABLE x` quietly makes
  //     an unfenced table sitting in the app's namespace.
  if (ddl) {
    let targetAt = -1;
    for (let at = solid(0), seen = 0; at !== -1; at = solid(at + 1)) {
      const token = tokens[at] as Token;
      if (seen < 2) { seen += 1; continue; }
      if (token.kind === "word" && BEFORE_TARGET.has(token.word)) continue;
      targetAt = at;
      break;
    }
    const target = targetAt === -1 ? undefined : tokens[targetAt] as Token;
    if (target?.kind !== "name") unnamespaced(target?.text ?? "");
    // The word right AFTER the target is the whole of what an ALTER may do.
    // Scanning the statement for any of these words instead would pass
    // `ALTER TABLE mine.x ENABLE ROW LEVEL SECURITY` on the head's own "alter".
    if (head[0] === "alter") {
      const verbAt = solid(targetAt + 1);
      const verb = verbAt === -1 ? undefined : tokens[verbAt] as Token;
      if (verb === undefined || verb.kind !== "word" || !ALTER_VERBS.has(verb.word)) {
        refuse(
          `ALTER TABLE may only ADD, DROP, RENAME or ALTER a column here, not "${verb?.text ?? "nothing"}". `
          + "Anything else changes how the table is fenced, which the app's database owns — change the columns, "
          + "not the table's settings.",
        );
      }
    }
  }

  // --- Word pairs that reach past the door from inside an allowed statement.
  const said: Token[] = tokens.filter((token) => token.text.trim() !== "");
  for (let index = 0; index < said.length; index += 1) {
    const word = (said[index] as Token).word;
    const next = said[index + 1]?.word;
    if (word === "into" && said[index - 1]?.word !== "insert") {
      refuse("SELECT … INTO makes a table outside the app's two namespaces. Write CREATE TABLE mine.<name> AS SELECT … instead.");
    }
    if (word === "rename" && next === "to") {
      refuse("A table cannot be renamed — the name is how the app's database fences it. Create the new table and copy the rows across.");
    }
    if (word === "set" && next === "schema") refuse("SET SCHEMA is not available: the app's database chooses where its tables live.");
    if (word === "owner" && next === "to") refuse("OWNER TO is not available: the app's database owns its own tables.");
  }

  let marker = 0;
  const out = tokens
    .map((token) => (token.kind === "param" && dialect === "postgres" ? `$${(marker += 1)}` : token.text))
    .join("");
  return { sql: out, ddl, mine, qualifiers: [...qualifiers] };
}
