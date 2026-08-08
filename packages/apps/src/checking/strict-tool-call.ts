/**
 * One model call whose answer is a TOOL CALL, not prose: the model is given
 * exactly one tool, told it must call it, and its arguments are validated
 * against the schema by the provider (Anthropic strict tool use). That is what
 * makes a closed answer space actually closed — a free-text answer can always
 * drift outside it.
 *
 * The AI reviewer (./reviewer.ts) is the one caller: its findings are a flat,
 * schema-pinned array. Everything here degrades to `undefined` rather than
 * throwing — a judgment call that could not be made is never a reason to throw a
 * generated app away.
 *
 * It lives beside its caller rather than in `generation/`: the floor must not
 * import a pipeline that is on its way to quarantine (§7.3).
 */
import { otelTelemetry } from "@vendoai/core";
import { modelCallParams } from "../model-params.js";
import type { FloorDependencies } from "./deps.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const strictToolCall = async (
  deps: FloorDependencies,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  system: string,
  prompt: string,
): Promise<Record<string, unknown> | undefined> => {
  // No model, no judgment — stated here rather than left to the catch below,
  // which would reach it as a TypeError on `model.modelId`.
  if (deps.model === undefined) return undefined;
  try {
    const { generateText, jsonSchema } = await import("ai");
    const result = await generateText({
      model: deps.model,
      // Opt-in OTel GenAI spans (VENDO_OTEL_TRACING=1).
      ...otelTelemetry("vendo.apps.check"),
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
