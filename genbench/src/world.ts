import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { JsonSchema, ToolDescriptor, VendoTheme } from "@vendoai/core";

/** The world file, as authored. `theme` is a VendoTheme verbatim and is handed
 *  to every contender unchanged. */
export interface WorldFile {
  readonly app: string;
  readonly theme: VendoTheme;
  readonly style: readonly string[];
  readonly tools: Readonly<Record<string, WorldTool>>;
}

export interface WorldTool {
  readonly does: string;
  /** Parameter name -> JSON Schema type name. Every key is required. */
  readonly takes?: Readonly<Record<string, string>>;
  /** Example rows the tool returns. Their shape derives `outputSchema`, and
   *  their literal values are the only numbers and dates a contender may show. */
  readonly data?: unknown;
}

export interface DerivedTool {
  readonly name: string;
  readonly descriptor: ToolDescriptor;
  readonly data: unknown;
}

export interface World {
  readonly app: string;
  readonly theme: VendoTheme;
  readonly style: readonly string[];
  readonly tools: readonly DerivedTool[];
  /** sha256 of the authored file — two runs only compare if these match. */
  readonly hash: string;
}

/** What a tool answers with, wherever it is asked: the registry the vendo run
 *  binds, the recorder every benchmark page carries, and the diy prompt. One
 *  definition, so a read's rows and a write's bare acknowledgement cannot mean
 *  one thing to one contender and another to the next. */
export const cannedResponse = (tool: DerivedTool): unknown => tool.data ?? { ok: true };

export type Lane = "screen" | "build";

export interface Case {
  readonly id: string;
  readonly lane: Lane;
  readonly prompt: string;
  readonly pass: readonly string[];
  /** Per-case tool-data override, e.g. an empty state. Replaces `data` for the
   *  named tools only; every other tool keeps the world's data. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** A tool that returns rows is a read; one that only takes arguments mutates.
 *  This decides the assembly loadout — the screen agent admits host tools only
 *  when `risk === "read"` (screen-agent.ts:449) — while every tool, read or not,
 *  still reaches the writer's brief and so can back an action. */
export function riskOf(tool: WorldTool): ToolDescriptor["risk"] {
  return tool.data === undefined ? "write" : "read";
}

/** One example value in, one JSON Schema out. Arrays describe their first row;
 *  every object key is required, because the world authors complete rows. */
export function jsonSchemaFromExample(value: unknown): JsonSchema {
  if (Array.isArray(value)) {
    const first = value[0];
    return first === undefined
      ? { type: "array" }
      : { type: "array", items: jsonSchemaFromExample(first) };
  }
  if (value === null) return { type: "null" };
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, v]) => [k, jsonSchemaFromExample(v)])),
      required: entries.map(([k]) => k),
      additionalProperties: false,
    };
  }
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function inputSchemaFrom(takes: WorldTool["takes"]): JsonSchema {
  const entries = Object.entries(takes ?? {});
  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([name, type]) => [name, { type }])),
    required: entries.map(([name]) => name),
    additionalProperties: false,
  };
}

function derive(name: string, tool: WorldTool, data: unknown): DerivedTool {
  return {
    name,
    data,
    descriptor: {
      name,
      description: tool.does,
      inputSchema: inputSchemaFrom(tool.takes),
      ...(data === undefined ? {} : { outputSchema: jsonSchemaFromExample(data) }),
      risk: riskOf(tool),
    },
  };
}

export async function loadWorld(path: string): Promise<World> {
  const source = await readFile(path, "utf8");
  const file = JSON.parse(source) as WorldFile;
  return {
    app: file.app,
    theme: file.theme,
    style: file.style,
    tools: Object.entries(file.tools).map(([name, tool]) => derive(name, tool, tool.data)),
    hash: createHash("sha256").update(JSON.stringify(file)).digest("hex").slice(0, 16),
  };
}

export async function loadCases(path: string): Promise<readonly Case[]> {
  const cases = JSON.parse(await readFile(path, "utf8")) as Case[];
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`genbench: duplicate case id "${testCase.id}"`);
    seen.add(testCase.id);
  }
  return cases;
}

/** The world this case actually runs against: the named tools' data (and the
 *  outputSchema derived from it) replaced, everything else untouched. */
export function worldForCase(world: World, testCase: Case): World {
  const overrides = testCase.data;
  if (overrides === undefined) return world;
  return {
    ...world,
    tools: world.tools.map((tool) => {
      if (!Object.hasOwn(overrides, tool.name)) return tool;
      const data = overrides[tool.name];
      return {
        ...tool,
        data,
        descriptor: {
          ...tool.descriptor,
          ...(data === undefined ? {} : { outputSchema: jsonSchemaFromExample(data) }),
        },
      };
    }),
  };
}
