import type {
  RunContext,
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
} from "@vendoai/core";

const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "host_items_list",
    description: "List items (read).",
    inputSchema: { type: "object" },
    risk: "read",
  },
  {
    name: "host_items_create",
    description: "Create an item (write).",
    inputSchema: { type: "object" },
    risk: "write",
  },
  {
    name: "host_noop",
    description: "A no-op read used as the guard wire-path proxy.",
    inputSchema: { type: "object" },
    risk: "read",
  },
];

/**
 * A trivial, deterministic ToolRegistry: execute returns immediately with a
 * fixed payload. The bench guard-binds this so the measured cost is the
 * decide → execute → report wire path, not host I/O.
 */
export const benchTools = (): ToolRegistry => ({
  async descriptors(): Promise<ToolDescriptor[]> {
    return DESCRIPTORS.map((d) => ({ ...d }));
  },
  async execute(call: ToolCall, _ctx: RunContext): Promise<ToolOutcome> {
    if (call.tool === "host_items_list") {
      return { status: "ok", output: { items: [{ id: "i1", name: "First" }, { id: "i2", name: "Second" }] } };
    }
    return { status: "ok", output: { ok: true } };
  },
});

export const benchContext = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `sess_${subject}`,
});
