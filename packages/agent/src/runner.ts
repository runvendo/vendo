import {
  VendoError,
  type AgentRunner,
  type AgentRunReport,
  type Guard,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
} from "@vendoai/core";
import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
} from "ai";
import { mintAuditId } from "./ids.js";
import { assembleSystemPrompt } from "./prompt.js";
import { buildAgentTools } from "./tools.js";
import {
  createCapabilityMissDetector,
  scrubCapabilityMissText,
  type CapabilityMissConfig,
} from "./capability-miss.js";

/** 03-agent §2 */
export interface RunnerConfig {
  model: LanguageModel;
  guard: Guard;
  system?: { product?: string; instructions?: string };
  context?: { maxOutputTokens?: number; toolOutputCap?: number };
  capabilityMiss?: CapabilityMissConfig;
}

interface RecordedCall {
  call: ToolCall;
  outcome: ToolOutcome["status"];
}

function fallbackSummary(status: AgentRunReport["status"], calls: RecordedCall[]): string {
  if (status === "error") return "The run could not be completed.";
  if (status === "stopped") return "The run stopped after reaching its tool-call budget.";
  const pending = calls.filter((entry) => entry.outcome === "pending-approval").length;
  if (pending > 0) return `The run completed with ${pending} tool call${pending === 1 ? "" : "s"} pending approval.`;
  return `The run completed with ${calls.length} tool call${calls.length === 1 ? "" : "s"}.`;
}

/** 03-agent §2 */
export function createRunner(config: RunnerConfig): AgentRunner {
  return async (task, ctx) => {
    const cap = task.budget?.maxToolCalls ?? 20;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new VendoError("validation", "maxToolCalls must be a positive integer");
    }

    const awayCtx: RunContext = { ...ctx, presence: "away" };
    const recorded: RecordedCall[] = [];
    let startedCalls = 0;
    let refusedCall = false;
    let report: AgentRunReport;

    try {
      const system = await assembleSystemPrompt(
        config.guard,
        awayCtx,
        config.system,
        config.capabilityMiss !== undefined,
      );
      const missDetector = config.capabilityMiss === undefined
        ? undefined
        : createCapabilityMissDetector({
            config: config.capabilityMiss,
            ctx: awayCtx,
            intent: scrubCapabilityMissText(task.prompt),
          });
      const tools = await buildAgentTools({
        registry: task.tools,
        ctx: awayCtx,
        toolOutputCap: config.context?.toolOutputCap,
        gate: () => {
          if (startedCalls >= cap) {
            refusedCall = true;
            return {
              status: "error",
              error: {
                code: "budget-exhausted",
                message: "Tool-call budget exhausted",
              },
            };
          }
          startedCalls += 1;
          return undefined;
        },
        onCall: (call) => {
          const entry: RecordedCall = { call, outcome: "error" };
          recorded.push(entry);
          const finishMissCall = missDetector?.onCall(call);
          return (outcome) => {
            entry.outcome = outcome.status;
            finishMissCall?.(outcome);
          };
        },
      });
      missDetector?.attach(tools);
      const toolCallCap: StopCondition<ToolSet> = ({ steps }) =>
        steps.reduce((count, step) => count + step.toolCalls.length, 0) >= cap;
      const result = await generateText({
        model: config.model,
        system,
        prompt: task.prompt,
        tools,
        stopWhen: [stepCountIs(cap), toolCallCap],
        maxOutputTokens: config.context?.maxOutputTokens,
        abortSignal: task.abortSignal,
      });
      const status = refusedCall || (result.finishReason === "tool-calls" && recorded.length >= cap)
        ? "stopped"
        : "ok";
      report = {
        status,
        summary: result.text.trim() || fallbackSummary(status, recorded),
        toolCalls: recorded,
      };
    } catch {
      const stopped = task.abortSignal?.aborted === true;
      report = {
        status: stopped ? "stopped" : "error",
        summary: stopped ? "The run was stopped." : fallbackSummary("error", recorded),
        toolCalls: recorded,
      };
    }

    try {
      await config.guard.report({
        id: mintAuditId(),
        at: new Date().toISOString(),
        kind: "run",
        principal: awayCtx.principal,
        venue: awayCtx.venue,
        presence: awayCtx.presence,
        appId: awayCtx.appId,
        trigger: awayCtx.trigger,
        outcome: undefined,
        detail: { status: report.status, toolCallCount: report.toolCalls.length },
      });
    } catch {
      // A reporting failure cannot change the completed run's result.
    }
    return report;
  };
}
