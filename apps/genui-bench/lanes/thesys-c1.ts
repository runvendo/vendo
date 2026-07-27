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
 * LIVE STATUS 2026-07-26: the key authenticates, but the Thesys organisation is
 * billing-suspended — every call returns 429 ERR_BILLING_THRESHOLD_EXCEEDED, so
 * the lane truthfully reports `failed` with that message and the recorded
 * fixture could not be re-recorded from a real response (see its _note). The
 * request path itself is exercised by the fixture test through the real openai
 * client; only C1's response DSL remains unverified against reality.
 */
import OpenAI from "openai";
import type { RunnableToolFunctionWithoutParse } from "openai/lib/RunnableFunction";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

export const C1_BASE_URL = "https://api.thesys.dev/v1/embed";
export const C1_MODEL = "c1/anthropic/claude-sonnet-4/v-20251230";

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
      try {
        const client = new OpenAI({
          apiKey,
          baseURL: deps.baseURL ?? C1_BASE_URL,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        const runner = client.chat.completions.runTools({
          model: C1_MODEL,
          messages: [{ role: "user", content: prompt }],
          tools: toRunnableTools(host),
        });
        // Official examples stream; runTools' runner exposes finalContent() on
        // both the streaming and non-streaming shapes, so this handles either.
        const c1Response = (await runner.finalContent()) ?? "";
        return {
          status: "ok",
          startedAt,
          durationMs: Date.now() - startedAt,
          raw: { model: C1_MODEL, c1Response, messages: runner.messages },
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
