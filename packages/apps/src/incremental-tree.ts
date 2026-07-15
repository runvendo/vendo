import {
  VENDO_TREE_FORMAT,
  type Json,
  type Tree,
  type TreeNode,
  type TreeQuery,
} from "@vendoai/core";

const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse a complete model response while tolerating prose or a JSON markdown fence. */
export const parseModelJson = (text: string): { value?: unknown; issues: string[] } => {
  const trimmed = text.trim();
  const fenced = JSON_FENCE.exec(trimmed)?.[1];
  const source = fenced ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const candidate = start === -1 || end < start ? source : source.slice(start, end + 1);
  try {
    return { value: JSON.parse(candidate) as unknown, issues: [] };
  } catch (error) {
    return {
      issues: [`model output is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`],
    };
  }
};

const parseString = (source: string, start: number | undefined): string | undefined => {
  if (start === undefined || source[start] !== '"') return undefined;
  const end = completeValueEnd(source, start);
  if (end === undefined) return undefined;
  try {
    const parsed = JSON.parse(source.slice(start, end)) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const completeValueEnd = (source: string, start: number): number | undefined => {
  const first = source[start];
  if (first === undefined) return undefined;
  if (first === '"') {
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return index + 1;
    }
    return undefined;
  }
  if (first !== "{" && first !== "[") return undefined;
  const expected: string[] = [first === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") expected.push("}");
    else if (character === "[") expected.push("]");
    else if (character === "}" || character === "]") {
      if (expected.at(-1) !== character) return undefined;
      expected.pop();
      if (expected.length === 0) return index + 1;
    }
  }
  return undefined;
};

const directPropertyStart = (
  source: string,
  objectStart: number | undefined,
  name: string,
): number | undefined => {
  if (objectStart === undefined || source[objectStart] !== "{") return undefined;
  let cursor = objectStart + 1;
  while (cursor < source.length) {
    while (/[\s,]/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "}" || source[cursor] === undefined || source[cursor] !== '"') return undefined;
    const keyEnd = completeValueEnd(source, cursor);
    if (keyEnd === undefined) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(cursor, keyEnd)) as unknown;
    } catch {
      return undefined;
    }
    cursor = keyEnd;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ":") return undefined;
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (key === name) return cursor;
    const valueEnd = completeValueEnd(source, cursor);
    if (valueEnd === undefined) return undefined;
    cursor = valueEnd;
  }
  return undefined;
};

const arrayObjects = (source: string, start: number | undefined): unknown[] => {
  if (start === undefined || source[start] !== "[") return [];
  const values: unknown[] = [];
  let cursor = start + 1;
  while (cursor < source.length) {
    while (/[\s,]/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "]" || source[cursor] === undefined) break;
    if (source[cursor] !== "{") break;
    const end = completeValueEnd(source, cursor);
    if (end === undefined) break;
    try {
      values.push(JSON.parse(source.slice(cursor, end)) as unknown);
    } catch {
      // A malformed, already-closed object is left for final validation/repair.
    }
    cursor = end;
  }
  return values;
};

const objectEntries = (source: string, start: number | undefined): Record<string, string> => {
  if (start === undefined || source[start] !== "{") return {};
  const entries: Record<string, string> = {};
  let cursor = start + 1;
  while (cursor < source.length) {
    while (/[\s,]/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "}" || source[cursor] === undefined || source[cursor] !== '"') break;
    const keyEnd = completeValueEnd(source, cursor);
    if (keyEnd === undefined) break;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(cursor, keyEnd)) as unknown;
    } catch {
      break;
    }
    cursor = keyEnd;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ":") break;
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    const valueEnd = completeValueEnd(source, cursor);
    if (valueEnd === undefined) break;
    try {
      const value = JSON.parse(source.slice(cursor, valueEnd)) as unknown;
      if (typeof key === "string" && typeof value === "string") entries[key] = value;
    } catch {
      break;
    }
    cursor = valueEnd;
  }
  return entries;
};

const completeObject = (source: string, start: number | undefined): Record<string, Json> | undefined => {
  if (start === undefined || source[start] !== "{") return undefined;
  const end = completeValueEnd(source, start);
  if (end === undefined) return undefined;
  try {
    const parsed = JSON.parse(source.slice(start, end)) as unknown;
    return isRecord(parsed) ? parsed as Record<string, Json> : undefined;
  } catch {
    return undefined;
  }
};

const isTreeNode = (value: unknown): value is TreeNode => isRecord(value)
  && typeof value.id === "string"
  && value.id.length > 0
  && typeof value.component === "string"
  && (value.source === undefined || ["prewired", "host", "generated"].includes(value.source as string))
  && (value.props === undefined || isRecord(value.props))
  && (value.children === undefined
    || (Array.isArray(value.children) && value.children.every((child) => typeof child === "string")));

const isTreeQuery = (value: unknown): value is TreeQuery => isRecord(value)
  && typeof value.path === "string"
  && typeof value.tool === "string"
  && (value.input === undefined || isRecord(value.input));

export interface IncrementalGeneratedTree {
  name?: string;
  description?: string;
  tree: Tree;
  components?: Record<string, string>;
}

/**
 * Extract complete tree members from a streamed JSON response. Incomplete values
 * stay buffered; only complete node/query/component values enter a snapshot.
 */
export class IncrementalTreeParser {
  #source = "";
  #signature = "";

  push(delta: string): IncrementalGeneratedTree | undefined {
    this.#source += delta;
    const documentStart = this.#source.indexOf("{");
    const treeStart = directPropertyStart(this.#source, documentStart, "tree");
    const formatVersion = parseString(
      this.#source,
      directPropertyStart(this.#source, treeStart, "formatVersion"),
    );
    const root = parseString(this.#source, directPropertyStart(this.#source, treeStart, "root"));
    if (formatVersion !== VENDO_TREE_FORMAT || root === undefined) return undefined;

    const nodes = arrayObjects(
      this.#source,
      directPropertyStart(this.#source, treeStart, "nodes"),
    ).filter(isTreeNode);
    if (!nodes.some((node) => node.id === root)) return undefined;
    const queries = arrayObjects(
      this.#source,
      directPropertyStart(this.#source, treeStart, "queries"),
    ).filter(isTreeQuery);
    const components = objectEntries(
      this.#source,
      directPropertyStart(this.#source, documentStart, "components"),
    );
    const data = completeObject(
      this.#source,
      directPropertyStart(this.#source, treeStart, "data"),
    );
    const name = parseString(this.#source, directPropertyStart(this.#source, documentStart, "name"));
    const signature = JSON.stringify([
      nodes.length,
      queries.length,
      Object.keys(components),
      data,
      name,
    ]);
    if (signature === this.#signature) return undefined;
    this.#signature = signature;

    const tree: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root,
      nodes: structuredClone(nodes),
      ...(data === undefined ? {} : { data: structuredClone(data) }),
      ...(queries.length === 0 ? {} : { queries: structuredClone(queries) }),
      ...(Object.keys(components).length === 0 ? {} : { components: structuredClone(components) }),
      // Additive wire marker: the renderer may skeleton missing generated source.
      streaming: true,
    } as Tree;
    const description = parseString(
      this.#source,
      directPropertyStart(this.#source, documentStart, "description"),
    );
    return {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      tree,
      ...(Object.keys(components).length === 0 ? {} : { components: structuredClone(components) }),
    };
  }

  text(): string {
    return this.#source;
  }
}
