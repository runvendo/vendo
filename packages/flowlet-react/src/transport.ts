import type { ChatTransport, UIMessageChunk } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";

export interface LocalTransport {
  transport: ChatTransport<FlowletUIMessage>;
}

/**
 * In-memory transport: drives an agent with no HTTP. F1's stand-in for the real
 * networked transport built in F2/F3. The return channel (tool approvals) is owned
 * by the ai SDK natively (`addToolApprovalResponse` -> auto-resubmit -> new turn), so
 * this transport just forwards each turn's messages to `agent.run`.
 */
export function createLocalTransport(agent: FlowletAgent): LocalTransport {
  const transport: ChatTransport<FlowletUIMessage> = {
    async sendMessages(options): Promise<ReadableStream<UIMessageChunk>> {
      return agent.run({
        messages: options.messages,
        tools: [],
        signal: options.abortSignal ?? new AbortController().signal,
      });
    },
    async reconnectToStream() {
      return null;
    },
  };

  return { transport };
}
