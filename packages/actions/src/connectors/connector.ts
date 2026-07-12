import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";

/** 04-actions §3: external tool sources — lean, we build zero. */
export interface Connector {
  name: string;
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}
