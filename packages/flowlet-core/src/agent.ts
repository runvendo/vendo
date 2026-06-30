import type { UIMessage, UIMessageChunk } from "ai";
import type { FlowletTool } from "./tool";

/**
 * Per-turn run input. The flow is turn-based: `run` is invoked with the current
 * messages, and the ai SDK re-invokes it after a tool approval (the SDK owns the
 * human-in-the-loop return channel, so there is no custom client-part callback).
 */
export interface RunInput {
  messages: UIMessage[]; // ai SDK UIMessage[] at the call site
  tools: FlowletTool[];
  system?: string;
  principal?: unknown;       // opaque in F1
  signal: AbortSignal;
}

export interface FlowletAgent {
  /** Emits an ai SDK UIMessage stream (incl. Flowlet data-* parts). */
  run(input: RunInput): ReadableStream<UIMessageChunk>;
}
