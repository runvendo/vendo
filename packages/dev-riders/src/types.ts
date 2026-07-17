/**
 * Structural copies of the @vendoai/agent rider seam (ENG-338). Kept local so
 * this package stays dependency-free — TypeScript's structural typing makes
 * these assignable where the umbrella wires a rider into the agent.
 */

/** The host-tool surface a rider session exposes to its model. */
export interface RiderToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (the MCP / dynamicTools wire form). */
  inputSchema: unknown;
}

/** Result handed back to the rider harness for one tool call. */
export interface RiderToolResult {
  /** Serialized tool outcome the model sees. */
  text: string;
  ok: boolean;
}

export interface RiderSessionStart {
  system: string;
  tools: RiderToolDescriptor[];
  /** The runtime's guarded executor; may stay pending for arbitrarily long
   *  while a human approval is parked. */
  onToolCall(call: { tool: string; args: unknown }): Promise<RiderToolResult>;
}

/** One persistent rider harness session, pinned to one Vendo thread. */
export interface RiderSession {
  start(options: RiderSessionStart): Promise<void>;
  runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }>;
  dispose(): Promise<void>;
}
