import type { ToolSet, UIMessageChunk } from "ai";
import type { FlowletUIMessage } from "./protocol";

/**
 * Per-turn run input. The flow is turn-based: `run` is invoked with the current
 * messages, and the ai SDK re-invokes it after a tool approval (the SDK owns the
 * human-in-the-loop return channel, so there is no custom client-part callback).
 */
export interface RunInput {
  messages: FlowletUIMessage[]; // carry Flowlet metadata + data parts at the call site
  tools: ToolSet;               // ai SDK tool set (Record<string, Tool>)
  system?: string;
  principal?: unknown;       // opaque in F1
  signal: AbortSignal;
  /**
   * Stable per-conversation id (ENG-193 §4.3 contextKey). Absent when the
   * caller doesn't track one; the engine mints its own per-run id either way
   * (FlowletMetadata.threadId), but a caller-supplied id lets grants persist
   * ACROSS turns of the same conversation rather than resetting every call.
   */
  threadId?: string;
}

export interface FlowletAgent {
  /** Emits an ai SDK UIMessage stream (incl. Flowlet data-* parts). */
  run(input: RunInput): ReadableStream<UIMessageChunk>;
}
