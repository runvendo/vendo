/**
 * OpenUI lane — openui-lang as a candidate generation format: one model call
 * produces a declarative openui-lang program (generation-time binding —
 * `Query("tool")` / `Mutation("tool")` references, no tool execution during
 * generation), which OpenUIPane renders with their real runtime
 * (@openuidev/react-lang `Renderer`) over their component library
 * (@openuidev/react-ui `openuiLibrary`, the same library this lane's system
 * prompt advertises). Tools resolve at render time through a toolProvider that
 * POSTs `/api/tools` — the same fixture executors every other lane uses.
 *
 * This is the same paradigm family as the Vendo lane (declarative queries
 * composed over a component catalog, data bound at render), which is what
 * makes it a comparable candidate; Thesys C1 emits the same language but only
 * behind their hosted API and envelope.
 *
 * Generation is single-shot with no repair loop, so `ok` means exactly "their
 * parser accepts the program as generated": a parse error, a truncated
 * program, or no root lands as status:"failed" (the analog of the Vendo
 * engine failing to produce a valid app). A program that parses but binds a
 * tool the host does not expose stays `ok` — it renders, with that query
 * erroring — and each such binding is reported as a warn Finding, the same
 * still-wrong-on-the-shipped-app vocabulary the Vendo lane's checking layer
 * uses (the CLI summary and pane header already count findings per lane).
 *
 * Model: same Anthropic path and key as the Vendo/CopilotKit lanes, pinned to
 * the engine's default id for family parity (`GENUI_BENCH_MODEL` overrides;
 * per-run `--model` stays Vendo-only, see README "Model controls"). No
 * sampling params are set: the Claude 5 line rejects `temperature`, and a
 * knob silently dropped for some models would make comparisons lie.
 */
import { createRequire } from "node:module";
import { createParser, type ToolSpec } from "@openuidev/lang-core";
import { openuiLibrary, openuiPromptOptions } from "@openuidev/react-ui";
import type { Finding } from "@vendoai/apps";
import type { ShapeType } from "@vendoai/core";
import { MAX_OUTPUT_TOKENS } from "../runner/models";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

// Same GENUI_BENCH_MODEL override the Vendo/CopilotKit lanes honor.
export const OPENUI_MODEL = process.env.GENUI_BENCH_MODEL ?? "claude-sonnet-4-6";

interface HostToolLike {
  name: string;
  description: string;
  risk?: string;
  inputSchema?: Record<string, unknown>;
}

/** The fixture's shape cards, translated for the prompt: the same response
 *  shapes the Vendo engine receives as `toolShapes`, as plain JSON Schema. */
export function shapeToJsonSchema(shape: ShapeType): Record<string, unknown> {
  switch (shape.kind) {
    case "array":
      return { type: "array", items: shapeToJsonSchema(shape.items) };
    case "object": {
      const optional = new Set(shape.optional ?? []);
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape.fields).map(([key, field]) => [key, shapeToJsonSchema(field)]),
        ),
        required: Object.keys(shape.fields).filter((key) => !optional.has(key)),
      };
    }
    case "json":
      return {};
    default:
      return { type: shape.kind };
  }
}

/** The generation surface: fixture tools as OpenUI ToolSpecs (input schema,
 *  response shape, read-only hint from the fixture's `risk`). */
export function toToolSpecs(host: HostFixture): ToolSpec[] {
  const shapes = host.shapes as Readonly<Record<string, ShapeType>>;
  return (host.tools as HostToolLike[]).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    outputSchema: shapes[tool.name] === undefined ? {} : shapeToJsonSchema(shapes[tool.name] as ShapeType),
    annotations: { readOnlyHint: tool.risk === "read" },
  }));
}

/** The model sometimes fences the program despite the prompt asking for raw
 *  code; every fenced block is program text (statements merge line-wise). */
export function extractProgram(text: string): string {
  const fenced = [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((match) => (match[1] as string).trim());
  return fenced.length > 0 ? fenced.join("\n") : text.trim();
}

/** Tool names the program binds (string-literal Query/Mutation targets). */
function boundTools(statements: Array<{ toolAST?: { k?: string; v?: unknown } | null }>): string[] {
  return statements
    .map((statement) => statement.toolAST)
    .filter((ast): ast is { k: string; v: string } => ast?.k === "Str" && typeof ast.v === "string")
    .map((ast) => ast.v);
}

/** Shape of `LaneResult.raw` for this lane (what OpenUIPane renders). */
export interface OpenUIRaw {
  model: string;
  /** Full assistant text as returned (fences included), for the internals drawer. */
  responseText: string;
  /** The openui-lang program OpenUIPane feeds their Renderer. */
  program: string;
  /** Tool names the program binds via Query()/Mutation(). */
  toolsReferenced: string[];
  /** Bound names the host does not expose — each is also a warn Finding. */
  toolsUnknown: string[];
  /** Their parser's metadata, for the internals drawer. */
  parseMeta: { statementCount: number; unresolved: string[]; orphaned: string[] };
}

export type OpenUIGenerate = (args: {
  modelId: string;
  system: string;
  prompt: string;
}) => Promise<string>;

/** Default generation: @ai-sdk/anthropic + generateText resolved through
 *  @vendoai/apps's module space (vendo lane pattern — this app declares no
 *  model SDK). The key is checked by the adapter before this runs. */
const runGeneration: OpenUIGenerate = async ({ modelId, system, prompt }) => {
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  const appsRequire = createRequire(appsEntry);
  const { createAnthropic } = appsRequire("@ai-sdk/anthropic") as {
    createAnthropic: (options: { apiKey: string }) => (id: string) => unknown;
  };
  const { generateText } = appsRequire("ai") as {
    generateText: (options: {
      model: unknown;
      system: string;
      prompt: string;
      maxOutputTokens: number;
    }) => Promise<{ text: string }>;
  };
  const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY as string })(modelId);
  const { text } = await generateText({ model, system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return text;
};

export interface OpenUIDeps {
  /** Test seam: canned model responses play back through the real extract →
   *  parse → findings path; no live API calls in tests. */
  generate?: OpenUIGenerate;
}

export function createOpenUIAdapter(deps: OpenUIDeps = {}): LaneAdapter {
  return {
    name: "openui",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      if (!process.env.ANTHROPIC_API_KEY) return { status: "no-key" };
      const startedAt = Date.now();
      try {
        const system = openuiLibrary.prompt({ ...openuiPromptOptions, tools: toToolSpecs(host) });
        const responseText = await (deps.generate ?? runGeneration)({
          modelId: OPENUI_MODEL,
          system,
          prompt,
        });
        const program = extractProgram(responseText);

        const parsed = createParser(openuiLibrary.toJSONSchema()).parse(program);
        const parseErrors = parsed.meta.errors;
        if (parsed.root === null || parseErrors.length > 0 || parsed.meta.incomplete) {
          const reasons = parseErrors.map((issue) => issue.message);
          if (parsed.meta.incomplete) reasons.push("program is incomplete (truncated output)");
          if (parsed.root === null) reasons.push("no renderable root statement");
          return {
            status: "failed",
            startedAt,
            durationMs: Date.now() - startedAt,
            error: `their parser rejected the program: ${reasons.join(" | ")}`,
            raw: { model: OPENUI_MODEL, responseText, program, parseErrors },
          };
        }

        const hostTools = new Set((host.tools as HostToolLike[]).map((tool) => tool.name));
        const toolsReferenced = [
          ...new Set([...boundTools(parsed.queryStatements), ...boundTools(parsed.mutationStatements)]),
        ].sort();
        const toolsUnknown = toolsReferenced.filter((tool) => !hostTools.has(tool));
        const findings: Finding[] = toolsUnknown.map((tool) => ({
          severity: "warn",
          where: `tool "${tool}"`,
          message: `the program binds "${tool}", which this host does not expose — that query errors at render`,
        }));

        const raw: OpenUIRaw = {
          model: OPENUI_MODEL,
          responseText,
          program,
          toolsReferenced,
          toolsUnknown,
          parseMeta: {
            statementCount: parsed.meta.statementCount,
            unresolved: parsed.meta.unresolved,
            orphaned: parsed.meta.orphaned,
          },
        };
        return { status: "ok", startedAt, durationMs: Date.now() - startedAt, findings, raw };
      } catch (error) {
        return {
          status: "failed",
          startedAt,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

const adapter = createOpenUIAdapter();
export default adapter;
