import { useEffect, useState } from "react";
import type { FileUIPart } from "ai";
import type { ConsentResponse } from "@vendoai/core";
import { useVendoThread } from "./use-vendo-thread";
import type { Feedback } from "./components/TurnActions";
import { useShell, type SendConsentResult } from "./context";
import type { Integration } from "./seams/integrations";
import { Landing } from "./components/Landing";
import { MessageList } from "./components/MessageList";
import { ThreadErrorBoundary } from "./components/ThreadErrorBoundary";
import { Composer } from "./components/Composer";
import { IntegrationsPicker } from "./components/IntegrationsPicker";
import { ConnectDock } from "./components/ConnectDock";
import { ConnectTray } from "./components/ConnectTray";
import { friendlyError, logErrorDetail } from "./components/error-copy";
import { VoiceStage } from "./voice/VoiceStage";
import { useVoiceSession } from "./voice/use-voice-session";
import { voiceSessionMessages } from "./voice/voice-messages";
import { voiceSessionBrief } from "./voice/session-brief";
import type { VoiceDriver } from "./voice/voice-session";

/**
 * ENG-193 PR #40 review — item B: nothing requires the SDK's approval resume
 * to wait on the consent POST — `fadeEligible` is purely client-side state
 * applied whenever the POST later settles, so `approve()` fires the POST and
 * resumes the SDK IMMEDIATELY, in parallel. This timeout still bounds how
 * long we keep watching a slow/HUNG POST for a `fadeEligible` result before
 * giving up on it — the same "best-effort, never blocking" posture this
 * module's docstring already promises for a failed POST, just no longer
 * gating the resume itself. */
const CONSENT_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export interface VendoThreadProps {
  greeting?: string;
  suggestions?: string[];
  /**
   * Hoist the composer into the Landing hero on the empty state (the library
   * page layout Yousef approved). OFF by default: the overlay and slot keep
   * their original bottom composer, and surfaces that opt in accept a one-time
   * composer remount on the first send (draft is empty at that moment).
   */
  heroComposer?: boolean;
  /**
   * Host sink for a turn's thumbs up/down. The shell stores no feedback itself;
   * omit to hide the feedback controls entirely.
   */
  onFeedback?: (messageId: string, feedback: Feedback) => void;
  /**
   * Realtime voice seam (ENG-185). When present, the composer grows a mic;
   * tapping it swaps this surface into the voice stage. Ending the session
   * lands its transcript + views in this thread as ordinary history.
   */
  voice?: VoiceDriver;
}

export function VendoThread({
  greeting, suggestions = [], heroComposer = false, onFeedback, voice,
}: VendoThreadProps) {
  const chat = useVendoThread();
  const { integrations, sendConsent, trust } = useShell();
  const [tools, setTools] = useState<Integration[]>([]);
  // False until the FIRST integrations list lands — the tray shows glass
  // shimmer placeholder rows for that window only.
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fadeProposal, setFadeProposal] = useState<{ messageId: string; toolName: string; proposalId: string; count?: number } | null>(null);
  const voiceSession = useVoiceSession(voice);

  // Context carry-over: conversation tail, on-screen views, and tool-result digests.
  const startVoice = () => {
    const context = voiceSessionBrief({ items: chat.items });
    voiceSession.start(context ? { context } : undefined);
  };

  // Cmd/Ctrl+Shift+K toggles a voice session (sibling of the overlay's Cmd+K).
  useEffect(() => {
    if (!voiceSession.supported || typeof window === "undefined") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (voiceSession.active) voiceSession.end();
        else startVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSession.supported, voiceSession.active, chat.items]);

  const refresh = () => {
    void integrations.list().then((list) => {
      setTools(list);
      setToolsLoaded(true);
    });
  };
  useEffect(refresh, [integrations]);
  // Re-list when a connection changes (e.g. the user connects a tool on screen),
  // so the rail and selector reflect it without a reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => refresh();
    window.addEventListener("vendo:integrations-changed", onChange);
    return () => window.removeEventListener("vendo:integrations-changed", onChange);
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

  const send = (text: string, files?: FileUIPart[]) => {
    const message: { text: string; files?: FileUIPart[] } = { text };
    if (files) message.files = files;
    void chat.sendMessage(message);
  };
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
  // ENG-193 §4.4: `sendConsent` resolves `SendConsentResult | void` (the
  // fade-eligibility passthrough) — `approve` below is the real consumer,
  // stashing a returned `fadeEligible` against the approval's turn.
  const postConsent = (response: ConsentResponse, toolName: string): Promise<SendConsentResult | void> =>
    sendConsent ? sendConsent(response, { toolName }).catch(() => undefined) : Promise.resolve(undefined);

  const approve = (approvalId: string) => {
    const item = findApproval(approvalId);
    // ENG-193 PR #40 review — item B: resume the SDK approval IMMEDIATELY —
    // nothing orders it after the consent POST. The POST (and any
    // `fadeEligible` it returns) proceeds independently in the background.
    chat.addToolApprovalResponse({ id: approvalId, approved: true });
    if (!item?.toolCallId) return;
    const consentPost = withTimeout(
      postConsent({ id: item.toolCallId, decision: "yes" }, item.toolName),
      CONSENT_TIMEOUT_MS,
    );
    void consentPost.then((result) => {
      if (result?.fadeEligible) {
        setFadeProposal({
          messageId: item.messageId,
          toolName: item.toolName,
          proposalId: result.fadeEligible.proposalId,
          count: result.fadeEligible.count,
        });
      }
    });
  };
  // Batch consent posts settle in parallel; this surfaces the FIRST
  // fadeEligible among them via the SAME fade-proposal state the single-card
  // `approve()` path above uses (review follow-up — previously the batch
  // paths fired the POSTs and threw away every response, so a fade proposal
  // earned by (say) the 3rd "yes" inside a batch never rendered). "First" is
  // array order (the batch's own toolCallId order), not resolution order —
  // `Promise.all` preserves that regardless of which POST settles first.
  const applyFirstFadeEligible = (
    settled: { result: SendConsentResult | void; item: ReturnType<typeof findApproval> }[],
  ) => {
    for (const { result, item } of settled) {
      if (result?.fadeEligible && item) {
        setFadeProposal({
          messageId: item.messageId,
          toolName: item.toolName,
          proposalId: result.fadeEligible.proposalId,
          count: result.fadeEligible.count,
        });
        return;
      }
    }
  };
  const resolveFade = (accept: boolean) => {
    if (!fadeProposal) return;
    const { proposalId } = fadeProposal;
    setFadeProposal(null);
    void trust?.resolveFadeProposal(proposalId, accept);
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
  // ENG-193 PR #40 review — item B: batch approvals resume the SDK
  // IMMEDIATELY too, same as the single `approve()` above — the consent
  // POSTs fire in parallel, fire-and-forget (mirrors `declineBatch` below,
  // which never waited on them either).
  const approveBatch = (approvalIds: string[], toolCallIds: string[]) => {
    approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true }));
    // Review follow-up: inspect the settled responses (instead of discarding
    // them) so a fadeEligible earned inside the batch can still surface.
    const posts = toolCallIds.map((id) => {
      const item = findApprovalByCall(id);
      return postConsent({ id, decision: "yes", subset: toolCallIds }, item?.toolName ?? "").then(
        (result) => ({ result, item }),
      );
    });
    void Promise.all(posts).then(applyFirstFadeEligible);
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
    approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true }));
    declinedApprovalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: false }));
    // Review follow-up: same as approveBatch — inspect the accepted subset's
    // settled responses for a fadeEligible instead of discarding them. The
    // declined siblings post "no" (never fade-eligible — consent.ts only
    // offers on a "yes" signal), so only the accepted ids need collecting.
    const posts = toolCallIds.map((id) => {
      const item = findApprovalByCall(id);
      return postConsent({ id, decision: "subset", subset: allToolCallIds }, item?.toolName ?? "").then(
        (result) => ({ result, item }),
      );
    });
    declinedToolCallIds.forEach((id) =>
      void postConsent(
        { id, decision: "no", subset: allToolCallIds },
        findApprovalByCall(id)?.toolName ?? "",
      ),
    );
    void Promise.all(posts).then(applyFirstFadeEligible);
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
      onVoice={voiceSession.supported ? startVoice : undefined}
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
          loading={!toolsLoaded}
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

  // The stage replaces the surface (the decided ENG-185 model: voice fills the
  // container it was launched from). On close, the session's transcript and
  // views land in this thread as ordinary messages — the record survives.
  if (voiceSession.active) {
    return (
      <div className="fl-thread">
        <VoiceStage
          snapshot={voiceSession.snapshot}
          onMute={voiceSession.mute}
          onEnd={voiceSession.end}
          onApprove={voiceSession.approve}
          onDecline={voiceSession.decline}
          onClosed={() => {
            const finalSnapshot = voiceSession.close();
            const landed = voiceSessionMessages(finalSnapshot);
            if (landed.length > 0) void chat.setMessages([...chat.messages, ...landed]);
          }}
        />
      </div>
    );
  }

  return (
    <div className="fl-thread">
      {empty ? (
        <Landing
          greeting={greeting}
          suggestions={suggestions}
          composer={composerInHero ? composerArea : undefined}
          onSuggestion={send}
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
            fadeProposal={fadeProposal}
            onAcceptFade={() => resolveFade(true)}
            onDeclineFade={() => resolveFade(false)}
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
      {/* heroComposer surfaces hoist the composer into the Landing hero while
          empty; everyone else keeps it here at the bottom, always. */}
      {!composerInHero && composerArea}
    </div>
  );
}
