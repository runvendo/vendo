import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { ClientPart, FlowletUIMessage, StubAgent } from "@flowlet/core";

export interface LocalTransport {
  transport: ChatTransport<FlowletUIMessage>;
  /** Push a client part (approval response / action) into the active run. */
  sendClientPart: (part: ClientPart) => void;
}

/**
 * In-memory transport: drives a (stub) agent with no HTTP. F1's stand-in for the
 * real networked transport built in F2/F3.
 */
export function createLocalTransport(agent: StubAgent): LocalTransport {
  const transport: ChatTransport<FlowletUIMessage> = {
    async sendMessages(options): Promise<ReadableStream<UIMessageChunk>> {
      return agent.run({
        messages: options.messages as unknown as UIMessage[],
        tools: [],
        signal: options.abortSignal ?? new AbortController().signal,
      });
    },
    async reconnectToStream() {
      return null;
    },
  };

  // The in-memory return channel: approval responses resolve the agent's pending
  // approval directly. (Sandbox actions are an F3 concern; carried but not yet routed.)
  const sendClientPart = (part: ClientPart) => {
    if (part.type === "data-approval-response") {
      agent.respondToApproval(part.data.approvalId, {
        approved: part.data.approved,
        editedInput: part.data.editedInput,
      });
    }
  };

  return { transport, sendClientPart };
}
