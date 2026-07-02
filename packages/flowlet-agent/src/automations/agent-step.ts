/**
 * The real AgentStepRunner (spec section a, hybrid nodes): a bounded ai SDK
 * generateText loop over the interpreter's already-gated RegisteredTools.
 *
 * The interpreter owns policy/grant gating (tools arrive wrapped) and performs
 * its own structural output validation as a backstop; this runner's job is the
 * model loop, the allowlist-only toolset, and schema-shaped final output via
 * the ai SDK's Output.object.
 */
import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool as aiTool,
  Output,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { AgentStepRequest, AgentStepRunner } from "./interpreter";

export interface AgentStepRunnerConfig {
  model: LanguageModel;
}

function buildSystem(request: AgentStepRequest): string {
  return [
    "You are executing ONE step of a standing automation, unattended — no user is present.",
    request.description !== undefined ? `The automation: ${request.description}` : "",
    `Your goal for this step: ${request.goal}`,
    "The user message contains this step's input data as JSON.",
    "Use only the provided tools, only as needed for the goal. If a tool call is",
    "rejected (approval required or denied by policy), do not retry it — work around",
    "it or finish with what you have.",
    request.outputSchema !== undefined
      ? "Produce a final result matching the required output schema exactly."
      : "When done, reply with a short plain-text summary of what you did.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createAgentStepRunner(config: AgentStepRunnerConfig): AgentStepRunner {
  return async (request) => {
    const tools: ToolSet = {};
    for (const [name, registered] of Object.entries(request.tools)) {
      let callCounter = 0;
      tools[name] = aiTool({
        description: registered.description ?? `The ${name} tool.`,
        inputSchema: jsonSchema<Record<string, unknown>>(
          registered.modelInputSchema ?? { type: "object", additionalProperties: true },
        ),
        // The ToolCallOutcome goes back to the model whole — an { ok: false }
        // rejection is information the model routes around, not an exception.
        execute: async (input) =>
          registered.execute(input, {
            idempotencyKey: `agent/${name}/${++callCounter}`,
          }),
      });
    }

    const common = {
      model: config.model,
      system: buildSystem(request),
      prompt: JSON.stringify(request.input),
      tools,
      // +1: the final non-tool step that produces the answer.
      stopWhen: stepCountIs(request.maxToolCalls + 1),
    };

    if (request.outputSchema !== undefined) {
      const result = await generateText({
        ...common,
        experimental_output: Output.object({ schema: jsonSchema(request.outputSchema) }),
      });
      return result.experimental_output;
    }
    const result = await generateText(common);
    return { text: result.text };
  };
}
