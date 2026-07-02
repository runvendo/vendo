import { useEffect, useMemo, useState } from "react";
import type { FileUIPart } from "ai";
import type { UINode } from "@flowlet/core";
import { useFlowletThread } from "./use-flowlet-thread";
import type { Feedback } from "./components/TurnActions";
import { useShell } from "./context";
import type { Flowlet } from "./seams/store";
import type { Integration } from "./seams/integrations";
import { Landing } from "./components/Landing";
import { MessageList } from "./components/MessageList";
import { ThreadErrorBoundary } from "./components/ThreadErrorBoundary";
import { Composer } from "./components/Composer";
import { IntegrationsRail } from "./components/IntegrationsRail";
import { IntegrationsPicker } from "./components/IntegrationsPicker";

export interface FlowletThreadProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onOpenFlow?: (flow: Flowlet) => void;
  /**
   * When set, shows a "Pin to card" footer that commits the latest rendered view
   * to a host slot. Slot-only seam — other surfaces omit it and render unchanged.
   */
  onPin?: (node: UINode) => void;
  /**
   * Host sink for a turn's thumbs up/down. The shell stores no feedback itself;
   * omit to hide the feedback controls entirely.
   */
  onFeedback?: (messageId: string, feedback: Feedback) => void;
}

export function FlowletThread({ greeting, suggestions = [], flows = [], onOpenFlow, onPin, onFeedback }: FlowletThreadProps) {
  const chat = useFlowletThread();
  const { integrations } = useShell();
  const [tools, setTools] = useState<Integration[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The most recent rendered view — what "Pin to card" commits.
  const latestNode = useMemo<UINode | null>(() => {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      const item = chat.items[i];
      if (item?.kind === "ui") return item.node;
    }
    return null;
  }, [chat.items]);

  const refresh = () => { void integrations.list().then(setTools); };
  useEffect(refresh, [integrations]);
  // Re-list when a connection changes (e.g. the user connects a tool on screen),
  // so the rail and selector reflect it without a reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => refresh();
    window.addEventListener("flowlet:integrations-changed", onChange);
    return () => window.removeEventListener("flowlet:integrations-changed", onChange);
  }, [integrations]); // eslint-disable-line react-hooks/exhaustive-deps
  // After each turn completes, re-list — a turn may have connected a tool
  // server-side (e.g. setting a Slack automation), and the rail should reflect it.
  useEffect(() => {
    if (chat.status === "ready") refresh();
  }, [chat.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (text: string, files?: FileUIPart[]) => { void chat.sendMessage({ text, files }); };
  const approve = (id: string) => { void chat.addToolApprovalResponse({ id, approved: true }); };
  const decline = (id: string) => { void chat.addToolApprovalResponse({ id, approved: false }); };
  const regenerate = (messageId: string) => { void chat.regenerate({ messageId }); };

  return (
    <div className="fl-thread">
      {chat.items.length === 0 ? (
        <Landing
          greeting={greeting}
          suggestions={suggestions}
          flows={flows}
          onSuggestion={send}
          onOpenFlow={(f) => onOpenFlow?.(f)}
        />
      ) : (
        <ThreadErrorBoundary resetKey={chat.items.length}>
          <MessageList
            items={chat.items}
            status={chat.status}
            onApprove={approve}
            onDecline={decline}
            onRegenerate={regenerate}
            onFeedback={onFeedback}
          />
        </ThreadErrorBoundary>
      )}
      {pickerOpen && (
        <IntegrationsPicker
          integrations={tools}
          onConnect={(id) => integrations.connect(id).then(refresh)}
          onDisconnect={(id) => integrations.disconnect(id).then(refresh)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <IntegrationsRail integrations={tools} onConnectClick={() => setPickerOpen(true)} />
      {/* One error surface: skip the banner when the stream already rendered an
          inline error item as the last turn, so a failure isn't shown twice. */}
      {chat.status === "error" && chat.items[chat.items.length - 1]?.kind !== "error" && (
        <div className="fl-error" role="alert">
          {chat.error?.message ?? "Something went wrong. Try again."}
        </div>
      )}
      {onPin && (
        <div className="fl-pinbar">
          <button
            type="button"
            className="fl-pin-btn"
            disabled={!latestNode}
            onClick={() => latestNode && onPin(latestNode)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 17v5" /><path d="M5 17h14l-1.5-4.5a2 2 0 0 1 0-1.3L19 7H5l1.5 4.2a2 2 0 0 1 0 1.3Z" />
            </svg>
            Pin to card
          </button>
          <span className="fl-pinbar-hint">{latestNode ? "pins the latest view" : "describe a view first"}</span>
        </div>
      )}
      <Composer onSend={send} status={chat.status} onStop={() => chat.stop()} />
    </div>
  );
}
