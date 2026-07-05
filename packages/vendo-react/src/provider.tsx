import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  capToolOutput,
  createRegistry,
  executeHostToolCall,
  type ComponentRegistry,
  type RegisteredComponent,
  type VendoAgent,
  type VendoUIMessage,
  type HostToolDefinition,
} from "@vendoai/core";
import { Chat, useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type ChatTransport } from "ai";
import { createLocalTransport, type LocalTransport } from "./transport.js";
import { hostAwareSendAutomaticallyWhen, pendingHostToolCalls } from "./host-tools.js";

interface VendoContextValue {
  registry: ComponentRegistry;
  local: LocalTransport;
  /** Shared Chat instance — every surface under this provider renders one thread. */
  chat: Chat<VendoUIMessage>;
}

const VendoContext = createContext<VendoContextValue | null>(null);

/** Chat-side cap for client-executed host-tool results (spec §5). */
const HOST_TOOL_OUTPUT_BUDGET = { maxChars: 16_000, attachNote: true } as const;

/**
 * Host-API tools executed in THIS browser on the user's existing session
 * (topology B, ENG-202). `definitions` must mirror the definitions the server
 * registered through the agent's caller seam — same manifest, both sides.
 */
export interface HostToolsConfig {
  definitions: HostToolDefinition[];
  /** Origin prefix for the host API; defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the browser's fetch. */
  fetchImpl?: typeof fetch;
}

export interface VendoProviderProps {
  /**
   * Drive the thread with an in-process agent (F1 stand-in). Mutually exclusive
   * with `transport`. The agent is server-only when it uses Composio, so a host
   * with a networked backend should pass `transport` instead.
   */
  agent?: VendoAgent;
  /**
   * Drive the thread with an explicit `ChatTransport` (e.g. an HTTP transport
   * pointed at a server route). Mutually exclusive with `agent`.
   */
  transport?: ChatTransport<VendoUIMessage>;
  components: RegisteredComponent[];
  /** Stable chat id; surfaces sharing it share one thread. */
  threadId?: string;
  /** Enable the browser-side executor for the host's own API tools. */
  hostTools?: HostToolsConfig;
  children: ReactNode;
}

export function VendoProvider({ agent, transport, components, threadId, hostTools, children }: VendoProviderProps) {
  const registry = useMemo(() => createRegistry(components), [components]);
  const local = useMemo<LocalTransport>(() => {
    if (transport) return { transport };
    if (agent) return createLocalTransport(agent);
    throw new Error("VendoProvider requires either `agent` or `transport`");
  }, [agent, transport]);
  // Keyed on the definitions ARRAY, not the config object: callers pass
  // `hostTools={{ definitions }}` inline, so the config's identity changes on
  // every parent render. A new Set here would rebuild the Chat below and wipe
  // the SDK's message/approval state mid-turn.
  const definitions = hostTools?.definitions;
  const hostToolNames = useMemo(
    () => new Set((definitions ?? []).map((def) => def.name)),
    [definitions],
  );
  // One Chat instance shared by every surface (dock, overlay, page) so they all
  // render the same thread. Surfaces consume it via useChat({ chat }).
  //
  // With host tools, auto-resubmission must additionally wait for the browser
  // executor's outputs (an approved host tool has no server execute — sending
  // without its output breaks the model turn).
  const chat = useMemo<Chat<VendoUIMessage>>(
    () =>
      new Chat<VendoUIMessage>({
        id: threadId,
        transport: local.transport,
        sendAutomaticallyWhen:
          hostToolNames.size > 0
            ? hostAwareSendAutomaticallyWhen(hostToolNames)
            : lastAssistantMessageIsCompleteWithApprovalResponses,
      }),
    [local, threadId, hostToolNames],
  );
  const value = useMemo<VendoContextValue>(() => ({ registry, local, chat }), [registry, local, chat]);
  return (
    <VendoContext.Provider value={value}>
      {hostTools ? <HostToolRunner chat={chat} config={hostTools} names={hostToolNames} /> : null}
      {children}
    </VendoContext.Provider>
  );
}

/**
 * The browser-side executor. Watches the shared thread; when the stream is
 * settled it executes each ready host tool call ONCE (un-gated calls, and
 * approved calls after the user answers the approval card) and feeds the
 * result back with `addToolOutput`, which auto-resubmits the turn.
 *
 * Deliberately NOT `onToolCall`: the SDK emits the tool call before its
 * approval request, so executing there would bypass the approval gate.
 */
function HostToolRunner({
  chat,
  config,
  names,
}: {
  chat: Chat<VendoUIMessage>;
  config: HostToolsConfig;
  names: ReadonlySet<string>;
}) {
  const { messages, status } = useChat<VendoUIMessage>({ chat });
  // toolCallIds already handed to the executor — guards double-execution
  // across re-renders (and React StrictMode double-effects).
  const started = useRef(new Set<string>());
  const defsByName = useMemo(
    () => new Map(config.definitions.map((def) => [def.name, def])),
    [config.definitions],
  );

  useEffect(() => {
    if (status !== "ready") return;
    for (const call of pendingHostToolCalls(messages[messages.length - 1], names)) {
      if (started.current.has(call.toolCallId)) continue;
      started.current.add(call.toolCallId);
      const def = defsByName.get(call.toolName);
      if (!def) continue;
      void executeHostToolCall(def, call.input, {
        baseUrl: config.baseUrl,
        fetchImpl: config.fetchImpl,
      })
        .then((output) =>
          chat.addToolOutput({
            tool: call.toolName,
            toolCallId: call.toolCallId,
            // Client-executed host results are a capping point too (spec §5):
            // a huge host API response would otherwise ride into the model
            // context uncapped.
            output: capToolOutput(output, HOST_TOOL_OUTPUT_BUDGET).result,
          }),
        )
        .catch((err: unknown) =>
          chat.addToolOutput({
            tool: call.toolName,
            toolCallId: call.toolCallId,
            state: "output-error",
            errorText: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  }, [messages, status, names, defsByName, chat, config.baseUrl, config.fetchImpl]);

  return null;
}

export function useVendoContext(): VendoContextValue {
  const ctx = useContext(VendoContext);
  if (!ctx) throw new Error("useVendoContext must be used within a VendoProvider");
  return ctx;
}
