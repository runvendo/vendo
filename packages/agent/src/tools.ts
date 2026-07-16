import {
  VENDO_APPS_CREATE_TOOL,
  VENDO_APPS_TOOL_PREFIX,
  VENDO_VIEW_STREAM,
  vendoViewStreamId,
  vendoViewPartSchema,
  type Guard,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type VendoApprovalPart,
  type VendoConnectPart,
  type VendoViewPart,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import {
  dynamicTool,
  jsonSchema,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";

type VendoPart = VendoApprovalPart | VendoConnectPart | VendoViewPart;

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

function writePart(
  writer: UIMessageStreamWriter<UIMessage> | undefined,
  part: VendoPart,
  id?: string,
): void {
  if (!writer) return;
  // The ai-SDK UI message stream requires custom data chunks to carry their
  // payload under `data` ({ type: "data-*", data }); the stock client's chunk
  // schema hard-rejects the flat form. The core part fields ride inside data.
  const { type, ...data } = part;
  writer.write({ type, data, ...(id === undefined ? {} : { id }) } as never);
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
      const call: VendoViewStreamingToolCall = { id: toolCallId, tool: descriptor.name, args: input };
      if (descriptor.name === VENDO_APPS_CREATE_TOOL && options.writer !== undefined) {
        Object.defineProperty(call, VENDO_VIEW_STREAM, {
          value: (update: { id: string; part: VendoViewPart }) => {
            const view = vendoViewPartSchema.safeParse(update.part);
            if (view.success) writePart(options.writer, view.data, update.id);
          },
        });
      }
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
      const producesView = descriptor.name.startsWith(VENDO_APPS_TOOL_PREFIX);
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
        if (view.success) writePart(options.writer, view.data, vendoViewStreamId(view.data.appId));
      } else if (outcome.status === "pending-approval") {
        writePart(options.writer, {
          type: "data-vendo-approval",
          toolCallId,
          risk: descriptor.risk,
          approvalId: outcome.approvalId,
        });
      } else if (outcome.status === "connect-required") {
        // The inline connect card (04-actions §3): emitted beside the native
        // tool part exactly like the approval part, keyed by toolCallId.
        writePart(options.writer, {
          type: "data-vendo-connect",
          toolCallId,
          connector: outcome.connect.connector,
          toolkit: outcome.connect.toolkit,
          message: outcome.connect.message,
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
