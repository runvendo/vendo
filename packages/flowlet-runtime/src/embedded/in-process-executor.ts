/**
 * Embedded implementation of the frozen Executor seam: tool calls run
 * in-process against host-registered functions (architecture Decision 2's
 * embedded row). Policy has already evaluated the call before it reaches any
 * executor; this seam only runs it. Fail-closed: unknown tools and thrown
 * errors both resolve to `{ ok: false }` outcomes — an executor never throws.
 */
import type {
  ExecutionContext,
  Executor,
  ToolCallOutcome,
  ToolCallRequest,
} from "@flowlet/core";

export type InProcessToolFn = (
  input: unknown,
  context: ExecutionContext,
) => Promise<ToolCallOutcome>;

export class InProcessExecutor implements Executor {
  constructor(private readonly tools: Record<string, InProcessToolFn>) {}

  async execute(call: ToolCallRequest, context: ExecutionContext): Promise<ToolCallOutcome> {
    const tool = this.tools[call.toolName];
    if (!tool) {
      return {
        ok: false,
        error: { code: "unknown_tool", message: `tool "${call.toolName}" is not registered` },
      };
    }
    try {
      return await tool(call.input, context);
    } catch (err) {
      return {
        ok: false,
        error: { code: "tool_error", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
