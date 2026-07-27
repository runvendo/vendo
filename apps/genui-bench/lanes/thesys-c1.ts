/**
 * Thesys C1 lane — the closest comparable: same prompt + the host's tool
 * catalog (translated to OpenAI function tools whose implementations call the
 * fixture's executors), sent to C1's Chat Completions-compatible endpoint.
 * The generated UI is the final assistant content string (C1 DSL), rendered
 * by their React SDK in ThesysPane.
 *
 * Note: Thesys is mid-rebrand to "OpenUI Cloud"; SDK versions are pinned in
 * package.json.
 *
 * LIVE STATUS 2026-07-26: verified end to end against the real API — the
 * runTools loop executes the fixture's tools and the final assistant content
 * is C1's `<content thesys="true" version="2">` envelope wrapping an
 * ```openui-lang``` program, which their SDK renders as-is (envelope included).
 * The recorded fixtures under `__fixtures__/` are that live traffic.
 *
 * C1 is model-agnostic: their catalog also carries OpenAI GPT-5/5.2 and Google
 * Gemini 3. We pin their current best Anthropic model so the comparison holds
 * the model family roughly constant with the Vendo lane; `THESYS_C1_MODEL`
 * overrides it for a one-off cross-provider look.
 */
import OpenAI from "openai";
import type { RunnableToolFunctionWithoutParse } from "openai/lib/RunnableFunction";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

export const C1_BASE_URL = "https://api.thesys.dev/v1/embed";
/** Their current best Anthropic model (GET /v1/embed/models, 2026-07-26). */
export const C1_MODEL = "c1/anthropic/claude-sonnet-4.6/v-20260331";

export function c1Model(): string {
  return process.env.THESYS_C1_MODEL || C1_MODEL;
}

interface HostToolLike {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** OpenAI function-tool names must match ^[a-zA-Z0-9_-]{1,64}$; map anything
 *  else onto a safe alias and execute under the original name. */
function toRunnableTools(host: HostFixture): RunnableToolFunctionWithoutParse[] {
  const seen = new Set<string>();
  return (host.tools as HostToolLike[]).map((tool) => {
    let safe = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    while (seen.has(safe)) safe = `${safe.slice(0, 62)}_x`;
    seen.add(safe);
    return {
      type: "function" as const,
      function: {
        name: safe,
        description: tool.description,
        parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        function: async (args: string) => {
          const input = (args ? JSON.parse(args) : {}) as Record<string, unknown>;
          try {
            return JSON.stringify(await host.execute(tool.name, input));
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
    };
  });
}

export interface ThesysC1Deps {
  /** Test seam: transport override — recorded fixtures play back through the real OpenAI client. */
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
}

export function createThesysC1Adapter(deps: ThesysC1Deps = {}): LaneAdapter {
  return {
    name: "thesys-c1",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      const apiKey = process.env.THESYS_API_KEY;
      if (!apiKey) return { status: "no-key" };
      const startedAt = Date.now();
      const model = c1Model();
      try {
        const client = new OpenAI({
          apiKey,
          baseURL: deps.baseURL ?? C1_BASE_URL,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        const runner = client.chat.completions.runTools({
          model,
          messages: [{ role: "user", content: prompt }],
          tools: toRunnableTools(host),
        });
        // Official examples stream; runTools' runner exposes finalContent() on
        // both the streaming and non-streaming shapes, so this handles either.
        // The string is C1's full `<content …>` envelope — their C1Component
        // parses the envelope itself, so it is passed through unmodified.
        const c1Response = (await runner.finalContent()) ?? "";
        return {
          status: "ok",
          startedAt,
          durationMs: Date.now() - startedAt,
          raw: { model, c1Response, messages: runner.messages },
        };
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

/** Shape of `LaneResult.raw` for this lane (what ThesysPane renders). */
export interface ThesysC1Raw {
  model: string;
  /** The generated UI: C1 DSL as returned in the final assistant content. */
  c1Response: string;
  /** Full conversation incl. tool calls + tool results, for the internals drawer. */
  messages: unknown[];
}

const adapter = createThesysC1Adapter();
export default adapter;
