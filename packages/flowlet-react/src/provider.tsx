import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createRegistry, type ComponentRegistry, type RegisteredComponent, type FlowletAgent, type FlowletUIMessage } from "@flowlet/core";
import { Chat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type ChatTransport } from "ai";
import { createLocalTransport, type LocalTransport } from "./transport";

interface FlowletContextValue {
  registry: ComponentRegistry;
  local: LocalTransport;
  /** Shared Chat instance — every surface under this provider renders one thread. */
  chat: Chat<FlowletUIMessage>;
}

const FlowletContext = createContext<FlowletContextValue | null>(null);

export interface FlowletProviderProps {
  /**
   * Drive the thread with an in-process agent (F1 stand-in). Mutually exclusive
   * with `transport`. The agent is server-only when it uses Composio, so a host
   * with a networked backend should pass `transport` instead.
   */
  agent?: FlowletAgent;
  /**
   * Drive the thread with an explicit `ChatTransport` (e.g. an HTTP transport
   * pointed at a server route). Mutually exclusive with `agent`.
   */
  transport?: ChatTransport<FlowletUIMessage>;
  components: RegisteredComponent[];
  /** Stable chat id; surfaces sharing it share one thread. */
  threadId?: string;
  children: ReactNode;
}

export function FlowletProvider({ agent, transport, components, threadId, children }: FlowletProviderProps) {
  const registry = useMemo(() => createRegistry(components), [components]);
  const local = useMemo<LocalTransport>(() => {
    if (transport) return { transport };
    if (agent) return createLocalTransport(agent);
    throw new Error("FlowletProvider requires either `agent` or `transport`");
  }, [agent, transport]);
  // One Chat instance shared by every surface (dock, overlay, page) so they all
  // render the same thread. Surfaces consume it via useChat({ chat }).
  const chat = useMemo<Chat<FlowletUIMessage>>(
    () =>
      new Chat<FlowletUIMessage>({
        id: threadId,
        transport: local.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      }),
    [local, threadId],
  );
  const value = useMemo<FlowletContextValue>(() => ({ registry, local, chat }), [registry, local, chat]);
  return <FlowletContext.Provider value={value}>{children}</FlowletContext.Provider>;
}

export function useFlowletContext(): FlowletContextValue {
  const ctx = useContext(FlowletContext);
  if (!ctx) throw new Error("useFlowletContext must be used within a FlowletProvider");
  return ctx;
}
