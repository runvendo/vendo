import { useEffect, useState } from "react";
import { useFlowletThread } from "./use-flowlet-thread";
import { useShell } from "./context";
import type { Flowlet } from "./seams/store";
import type { Integration } from "./seams/integrations";
import { Landing } from "./components/Landing";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { IntegrationsRail } from "./components/IntegrationsRail";
import { IntegrationsPicker } from "./components/IntegrationsPicker";

export interface FlowletThreadProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onOpenFlow?: (flow: Flowlet) => void;
}

export function FlowletThread({ greeting, suggestions = [], flows = [], onOpenFlow }: FlowletThreadProps) {
  const chat = useFlowletThread();
  const { integrations } = useShell();
  const [tools, setTools] = useState<Integration[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = () => { void integrations.list().then(setTools); };
  useEffect(refresh, [integrations]);

  const send = (text: string) => { void chat.sendMessage({ text }); };
  const approve = (id: string) => { void chat.addToolApprovalResponse({ id, approved: true }); };
  const decline = (id: string) => { void chat.addToolApprovalResponse({ id, approved: false }); };

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
        <MessageList items={chat.items} status={chat.status} onApprove={approve} onDecline={decline} />
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
      {chat.status === "error" && (
        <div className="fl-error" role="alert">
          {chat.error?.message ?? "Something went wrong. Try again."}
        </div>
      )}
      <Composer onSend={send} status={chat.status} onStop={() => chat.stop()} />
    </div>
  );
}
