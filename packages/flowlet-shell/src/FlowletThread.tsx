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
import { ConnectDock } from "./components/ConnectDock";
import { ConnectTray } from "./components/ConnectTray";
import { ConnectBarMorph } from "./components/ConnectBarMorph";
import { friendlyError, logErrorDetail } from "./components/error-copy";

export interface FlowletThreadProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onOpenFlow?: (flow: Flowlet) => void;
  /** Library management on the empty-state gallery (ENG-183). */
  onRenameFlow?: (flow: Flowlet, name: string) => void;
  onPinFlow?: (flow: Flowlet, pinned: boolean) => void;
  onDeleteFlow?: (flow: Flowlet) => void;
  /**
   * Hoist the composer into the Landing hero on the empty state (the library
   * page layout Yousef approved). OFF by default: the overlay and slot keep
   * their original bottom composer, and surfaces that opt in accept a one-time
   * composer remount on the first send (draft is empty at that moment).
   */
  heroComposer?: boolean;
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
  /**
   * Where the connect-tools entry lives (ENG-205 exploration). "rail" is the
   * legacy pill row above the composer; the dock variants move it into the
   * chat bar: "icon-tray" (tools button + liquid tray), "chip-cluster"
   * (brand-coin cluster + tray), "bar-morph" (the bar morphs into the picker).
   * Default stays "rail" until Yousef picks the winner.
   */
  connectEntry?: "rail" | "icon-tray" | "chip-cluster" | "bar-morph";
}

export function FlowletThread({
  greeting, suggestions = [], flows = [], onOpenFlow, onRenameFlow, onPinFlow, onDeleteFlow,
  heroComposer = false, onPin, onFeedback, connectEntry = "rail",
}: FlowletThreadProps) {
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
  // Developers get the raw error in the console; the DOM only ever carries the
  // friendly copy (a title attribute would leak it to hover + the a11y tree).
  useEffect(() => {
    if (chat.status === "error") logErrorDetail(chat.error);
  }, [chat.status, chat.error]);

  const send = (text: string, files?: FileUIPart[]) => { void chat.sendMessage({ text, files }); };
  const approve = (id: string) => { void chat.addToolApprovalResponse({ id, approved: true }); };
  const decline = (id: string) => { void chat.addToolApprovalResponse({ id, approved: false }); };
  const regenerate = (messageId: string) => { void chat.regenerate({ messageId }); };

  const empty = chat.items.length === 0;
  const dockActive = connectEntry !== "rail";
  const pickerEl = (
    <IntegrationsPicker
      integrations={tools}
      onConnect={(id) => integrations.connect(id).then(refresh)}
      onDisconnect={(id) => integrations.disconnect(id).then(refresh)}
      onClose={() => setPickerOpen(false)}
    />
  );
  const accessory = dockActive ? (
    <ConnectDock
      variant={connectEntry === "chip-cluster" ? "cluster" : "icon"}
      integrations={tools}
      open={pickerOpen}
      onToggle={() => setPickerOpen((v) => !v)}
    />
  ) : undefined;
  const composerEl = (
    <Composer onSend={send} status={chat.status} onStop={() => chat.stop()} accessory={accessory} />
  );
  const composerInHero = heroComposer && empty;
  // The dock variants replace the bottom composer with their own arrangement;
  // the hero hoist keeps the plain composer (dock productization will revisit).
  const composerArea =
    connectEntry === "bar-morph" ? (
      <ConnectBarMorph
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        bar={composerEl}
        panel={pickerEl}
      />
    ) : dockActive ? (
      <div className="fl-dock-anchor">
        <ConnectTray open={pickerOpen} onClose={() => setPickerOpen(false)}>
          {pickerEl}
        </ConnectTray>
        {composerEl}
      </div>
    ) : (
      composerEl
    );

  return (
    <div className="fl-thread">
      {empty ? (
        <Landing
          greeting={greeting}
          suggestions={suggestions}
          flows={flows}
          composer={composerInHero ? composerArea : undefined}
          onSuggestion={send}
          onOpenFlow={(f) => onOpenFlow?.(f)}
          onRenameFlow={onRenameFlow}
          onPinFlow={onPinFlow}
          onDeleteFlow={onDeleteFlow}
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
      {!dockActive && pickerOpen && pickerEl}
      {!dockActive && (
        <IntegrationsRail integrations={tools} onConnectClick={() => setPickerOpen(true)} />
      )}
      {/* One error surface: skip the banner when the stream already rendered an
          inline error item as the last turn (no double-reporting), and when the
          thread has been reset to empty (a stale banner over the landing is
          noise). Raw provider text never reaches the DOM (not even a title
          attribute — hover and the a11y tree would expose it); friendlyError
          maps the copy and the raw detail goes to the console. */}
      {chat.status === "error" &&
        chat.items.length > 0 &&
        chat.items[chat.items.length - 1]?.kind !== "error" && (
          <div className="fl-error" role="alert">
            <span>{friendlyError(chat.error).message}</span>
            {friendlyError(chat.error).retryable && (
              <button
                type="button"
                className="fl-error-retry"
                onClick={() => {
                  chat.clearError();
                  void chat.regenerate();
                }}
              >
                Retry
              </button>
            )}
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
      {/* heroComposer surfaces hoist the composer into the Landing hero while
          empty; everyone else keeps it here at the bottom, always. */}
      {!composerInHero && composerArea}
    </div>
  );
}
