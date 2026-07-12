import {
  vendoViewPartSchema,
  type Guard,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type VendoApprovalPart,
  type VendoViewPart,
} from "@vendoai/core";
import {
  dynamicTool,
  jsonSchema,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";

type VendoPart = VendoApprovalPart | VendoViewPart;

/** 03-agent §2 */
export interface ToolBridgeOptions {
  registry: ToolRegistry;
  ctx: RunContext;
  guard?: Guard;
  writer?: UIMessageStreamWriter<UIMessage>;
  toolOutputCap?: number;
  onCall?: (call: ToolCall) => (outcome: ToolOutcome) => void;
}

function writePart(writer: UIMessageStreamWriter<UIMessage> | undefined, part: VendoPart): void {
  if (!writer) return;
  writer.write(part as never);
}

function executionError(error: unknown): ToolOutcome {
  let message = "Tool execution failed";
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else {
    try {
      message = String(error);
    } catch {
      // Keep the fallback when even coercion is hostile.
    }
  }
  return {
    status: "error",
    error: {
      code: "execution",
      message,
    },
  };
}

function capOutcome(outcome: ToolOutcome, cap: number | undefined): ToolOutcome {
  if (outcome.status !== "ok" || cap === undefined) return outcome;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(outcome.output);
  } catch (error) {
    return executionError(error);
  }
  if (serialized === undefined || serialized.length <= cap) return outcome;
  return {
    status: "ok",
    output: {
      truncated: true,
      chars: serialized.length,
      preview: serialized.slice(0, cap),
    },
  };
}

/** 03-agent §2 */
export async function buildAgentTools(options: ToolBridgeOptions): Promise<ToolSet> {
  const descriptors = await options.registry.descriptors();
  const tools: ToolSet = {};

  for (const descriptor of descriptors) {
    const execute = async (input: unknown, { toolCallId }: { toolCallId: string }): Promise<ToolOutcome> => {
      const call: ToolCall = { id: toolCallId, tool: descriptor.name, args: input };
      const finishCall = options.onCall?.(call);
      let outcome: ToolOutcome;
      try {
        outcome = await options.registry.execute(call, options.ctx);
      } catch (error) {
        outcome = executionError(error);
      }

      if (outcome.status === "ok") {
        const surface = typeof outcome.output === "object" && outcome.output !== null
          ? outcome.output as Record<string, unknown>
          : undefined;
        const candidate = surface
          ? { type: "data-vendo-view", appId: surface.appId, payload: surface.payload }
          : null;
        const view = vendoViewPartSchema.safeParse(candidate);
        if (view.success) writePart(options.writer, view.data);
      } else if (outcome.status === "pending-approval") {
        writePart(options.writer, {
          type: "data-vendo-approval",
          toolCallId,
          risk: descriptor.risk,
          approvalId: outcome.approvalId,
        });
      }

      const modelOutcome = capOutcome(outcome, options.toolOutputCap);
      finishCall?.(modelOutcome);
      return modelOutcome;
    };

    const needsApproval = options.guard
      ? async (input: unknown, { toolCallId }: { toolCallId: string }): Promise<boolean> => {
          try {
            const decision = await options.guard!.check(
              { id: toolCallId, tool: descriptor.name, args: input },
              descriptor,
              options.ctx,
            );
            if (decision.action !== "ask") return false;
            writePart(options.writer, {
              type: "data-vendo-approval",
              toolCallId,
              risk: descriptor.risk,
              approvalId: decision.approval.id,
            });
            return true;
          } catch {
            return true;
          }
        }
      : undefined;

    tools[descriptor.name] = dynamicTool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute,
      ...(needsApproval ? { needsApproval } : {}),
    });
  }

  return tools;
}
