import type { UIMessageChunk } from "ai";
import type { FlowletTool } from "./tool";
import type { ClientPart } from "./protocol";

export interface RunInput {
  messages: { role: string; parts: unknown[] }[]; // ai SDK UIMessage[] at the call site
  tools: FlowletTool[];
  system?: string;
  principal?: unknown;       // opaque in F1
  signal: AbortSignal;
  /** In-band return channel: approval responses + sandbox actions reach the run here. */
  onClientPart?: (part: ClientPart) => void;
}

export interface FlowletAgent {
  /** Emits an ai SDK UIMessage stream (incl. Flowlet data-* parts). */
  run(input: RunInput): ReadableStream<UIMessageChunk>;
}
