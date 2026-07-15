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
  gate?: (call: ToolCall) => ToolOutcome | undefined;
  onCall?: (call: ToolCall) => (outcome: ToolOutcome) => void;
}

function writePart(writer: UIMessageStreamWriter<UIMessage> | undefined, part: VendoPart): void {
  if (!writer) return;
  // The ai-SDK UI message stream requires custom data chunks to carry their
  // payload under `data` ({ type: "data-*", data }); the stock client's chunk
  // schema hard-rejects the flat form. The core part fields ride inside data.
  const { type, ...data } = part;
  writer.write({ type, data } as never);
}

function executionError(): ToolOutcome {
  return {
    status: "error",
    error: {
      code: "execution",
      message: "Tool execution failed.",
    },
  };
}

function capOutcome(outcome: ToolOutcome, cap: number | undefined): ToolOutcome {
  if (outcome.status !== "ok" || cap === undefined) return outcome;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(outcome.output);
  } catch {
    return executionError();
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
      let outcome = options.gate?.(call);
      if (outcome === undefined) {
        try {
          outcome = await options.registry.execute(call, options.ctx);
        } catch {
          outcome = executionError();
        }
      }

      // A view part is emitted ONLY from the app runtime's own view-producing
      // tools returning a tree OpenSurface (06 §1) — never by duck-typing an
      // arbitrary host tool's output, which could otherwise smuggle an unrelated
      // result onto the app-view channel and mis-route its actions (01 §16).
      const producesView = descriptor.name.startsWith("vendo_apps_");
      if (outcome.status === "ok" && producesView) {
        const surface = typeof outcome.output === "object" && outcome.output !== null
          ? outcome.output as Record<string, unknown>
          : undefined;
        const args = typeof input === "object" && input !== null
          ? input as Record<string, unknown>
          : undefined;
        const candidate = surface?.kind === "tree" && surface.payload !== undefined
          ? {
              type: "data-vendo-view",
              // OpenSurface carries no app id (06 §1); the open call's own appId
              // argument identifies the app this payload belongs to.
              appId: surface.appId ?? args?.appId,
              payload: surface.payload,
            }
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
              ...(decision.approval.invalidatedGrant === undefined
                ? {}
                : { invalidatedGrant: decision.approval.invalidatedGrant }),
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
