/**
 * One model call whose answer is a TOOL CALL, not prose: the model is given
 * exactly one tool, told it must call it, and its arguments are validated
 * against the schema by the provider (Anthropic strict tool use). That is what
 * makes a closed answer space actually closed — a free-text answer can always
 * drift outside it.
 *
 * The AI reviewer (../checking/reviewer.ts) is the one caller: its findings are
 * a flat, schema-pinned array. Everything here degrades to `undefined` rather
 * than throwing — a judgment call that could not be made is never a reason to
 * throw a generated app away.
 */
import { modelCallParams } from "../model-params.js";
import type { GenerationDependencies } from "./engine.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const strictToolCall = async (
  deps: GenerationDependencies,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  system: string,
  prompt: string,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const { generateText, jsonSchema } = await import("ai");
    const result = await generateText({
      model: deps.model,
      system,
      prompt,
      tools: {
        [toolName]: {
          description,
          inputSchema: jsonSchema(inputSchema as never),
          // Anthropic strict tool use (GA): the arguments MUST validate against
          // the schema — enum values become unsamplable otherwise.
          strict: true,
        } as never,
      },
      toolChoice: { type: "tool", toolName },
      ...modelCallParams(deps.model),
      maxRetries: 0,
    });
    const call = result.toolCalls.find((candidate) => candidate.toolName === toolName);
    if (call === undefined || !isRecord(call.input)) return undefined;
    return call.input;
  } catch {
    return undefined;
  }
};
