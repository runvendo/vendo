import { useEffect, useMemo, useState } from "react";
import type { FileUIPart } from "ai";
import type { ConsentResponse, UINode } from "@flowlet/core";
import { useFlowletThread } from "./use-flowlet-thread";
import type { Feedback } from "./components/TurnActions";
import { useShell } from "./context";
import type { Flowlet } from "./seams/store";
import type { Integration } from "./seams/integrations";
import { Landing } from "./components/Landing";
import { MessageList } from "./components/MessageList";
import { ThreadErrorBoundary } from "./components/ThreadErrorBoundary";
import { Composer } from "./components/Composer";
import { IntegrationsPicker } from "./components/IntegrationsPicker";
import { ConnectDock } from "./components/ConnectDock";
import { ConnectTray } from "./components/ConnectTray";
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
}

export function FlowletThread({
  greeting, suggestions = [], flows = [], onOpenFlow, onRenameFlow, onPinFlow, onDeleteFlow,
  heroComposer = false, onPin, onFeedback,
}: FlowletThreadProps) {
  const chat = useFlowletThread();
  const { integrations, sendConsent } = useShell();
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
  const regenerate = (messageId: string) => { void chat.regenerate({ messageId }); };

  const findApproval = (approvalId: string) =>
    chat.items.find((i): i is Extract<typeof chat.items[number], { kind: "approval" }> =>
      i.kind === "approval" && i.approvalId === approvalId,
    );

  const findApprovalByCall = (toolCallId: string) =>
    chat.items.find((i): i is Extract<typeof chat.items[number], { kind: "approval" }> =>
      i.kind === "approval" && i.toolCallId === toolCallId,
    );

  // Consent-channel POSTs are best-effort (ENG-193 §4.5): a failed or absent
  // POST must never block or break the SDK's native approval resume, so every
  // send is swallowed here and the SDK response proceeds either way. toolName
  // rides beside the response — the consent endpoints require the client's
  // tool-name assertion to cross-check against the pending part.
  const postConsent = (response: ConsentResponse, toolName: string): Promise<void> =>
    sendConsent ? sendConsent(response, { toolName }).catch(() => {}) : Promise.resolve();

  const approve = (approvalId: string) => {
    const item = findApproval(approvalId);
    const consentPost = item?.toolCallId
      ? postConsent({ id: item.toolCallId, decision: "yes" }, item.toolName)
      : Promise.resolve();
    void consentPost.then(() => chat.addToolApprovalResponse({ id: approvalId, approved: true }));
  };
  const decline = (approvalId: string) => {
    // Declines reach the consent channel too (spec §4.4/§4.5 — the audit
    // trail records EVERY decision, and fades need the "no" signal).
    // Fire-and-forget: the SDK boolean never waits on the POST.
    const item = findApproval(approvalId);
    if (item?.toolCallId) void postConsent({ id: item.toolCallId, decision: "no" }, item.toolName);
    void chat.addToolApprovalResponse({ id: approvalId, approved: false });
  };

  // Batch semantics: the consent `subset` field lists the BATCH's toolCallIds
  // for audit context, while the per-id SDK responses below carry the actual
  // approve/decline split.
  const approveBatch = (approvalIds: string[], toolCallIds: string[]) => {
    const consentPosts = Promise.all(
      toolCallIds.map((id) =>
        postConsent(
          { id, decision: "yes", subset: toolCallIds },
          findApprovalByCall(id)?.toolName ?? "",
        ),
      ),
    );
    void consentPosts.then(() =>
      approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true })),
    );
  };
  const approveSubset = (
    approvalIds: string[], toolCallIds: string[], allApprovalIds: string[], allToolCallIds: string[],
  ) => {
    // Declined siblings = the batch's own ids minus the selected ones — keyed
    // by approvalId so an item with no toolCallId still gets its SDK decline.
    const declinedApprovalIds = allApprovalIds.filter((id) => !approvalIds.includes(id));
    const declinedToolCallIds = declinedApprovalIds
      .map((id) => findApproval(id)?.toolCallId)
      .filter((id): id is string => !!id);
    const consentPosts = Promise.all([
      ...toolCallIds.map((id) =>
        postConsent(
          { id, decision: "subset", subset: allToolCallIds },
          findApprovalByCall(id)?.toolName ?? "",
        ),
      ),
      ...declinedToolCallIds.map((id) =>
        postConsent(
          { id, decision: "no", subset: allToolCallIds },
          findApprovalByCall(id)?.toolName ?? "",
        ),
      ),
    ]);
    void consentPosts.then(() => {
      approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true }));
      declinedApprovalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: false }));
    });
  };
  const declineBatch = (approvalIds: string[]) => {
    approvalIds.forEach((approvalId) => {
      const item = findApproval(approvalId);
      if (item?.toolCallId) void postConsent({ id: item.toolCallId, decision: "no" }, item.toolName);
      void chat.addToolApprovalResponse({ id: approvalId, approved: false });
    });
  };

  const empty = chat.items.length === 0;
  // The connect-tools entry lives in the bar (ENG-205): a dock button beside
  // attach plus the liquid tray anchored above the composer, on every surface
  // (the hero hoist carries the same arrangement).
  const composerEl = (
    <Composer
      onSend={send}
      status={chat.status}
      onStop={() => chat.stop()}
      accessory={
        <ConnectDock
          integrations={tools}
          open={pickerOpen}
          onToggle={() => setPickerOpen((v) => !v)}
        />
      }
    />
  );
  const composerInHero = heroComposer && empty;
  const composerArea = (
    <div className="fl-dock-anchor">
      <ConnectTray open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <IntegrationsPicker
          integrations={tools}
          // Resolves only after the refreshed list has landed in state, so the
          // picker's connecting row can observe its flip to connected.
          onConnect={(id) => integrations.connect(id).then(() => integrations.list()).then(setTools)}
          onDisconnect={(id) => integrations.disconnect(id).then(refresh)}
          onClose={() => setPickerOpen(false)}
        />
      </ConnectTray>
      {composerEl}
    </div>
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
            onApproveBatch={approveBatch}
            onApproveSubset={approveSubset}
            onDeclineBatch={declineBatch}
            onRegenerate={regenerate}
            onFeedback={onFeedback}
          />
        </ThreadErrorBoundary>
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
