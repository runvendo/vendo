import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useVendoProvider } from "../context.js";
import { announcePin } from "../pin-events.js";
import { noteSlot } from "../slot-notes.js";
import { useApp } from "../hooks/use-app.js";
import { useSlotApp } from "../hooks/use-slot-app.js";
import { FluidReveal } from "../tree/fluid-reveal.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import { ChromeRoot } from "./chrome-root.js";
import { defaultSlotSuggestions } from "./discoverability.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";
import { openVendoPalette } from "./palette-hotkey.js";
import { BUILD_FAILURE_COPY } from "./thread/message-data.js";

/** A slot id is a code identifier ("net-worth-card"); the person choosing a
 *  destination in the picker reads words. */
function slotLabel(id: string): string {
  const words = id.replace(/[-_]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The faint skeleton behind the ghost/empty states — decorative only. */
function GhostSkeleton() {
  return (
    <span className="fl-slot-skel" aria-hidden="true">
      <span className="fl-skel-line" style={{ width: "54%" }} />
      <span className="fl-skel-line" style={{ width: "78%" }} />
      <span className="fl-skel-line" style={{ width: "42%" }} />
      <span className="fl-skel-bars">
        <span style={{ height: "42%" }} />
        <span style={{ height: "68%" }} />
        <span style={{ height: "52%" }} />
        <span style={{ height: "84%" }} />
        <span style={{ height: "62%" }} />
      </span>
    </span>
  );
}

function SlotGhost({ label, detail, loading = false }: { label: string; detail?: string; loading?: boolean }) {
  return (
    <div className="fl-slot-ghost" role={loading ? "status" : undefined} aria-live={loading ? "polite" : undefined}>
      <GhostSkeleton />
      <span className="fl-slot-cta">
        <span className="fl-slot-cta-label">{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

/**
 * The consumer's half of a failed load (spec §16 law 3, the consumer-voice
 * law). Every sentence the wire throws is written for the HOST DEVELOPER — one
 * names an environment variable, another carries an app id — so rendering
 * `reason.message` put all of them on a HOST PAGE, the most public surface we
 * have. The developer sentence keeps its home (the server's own error, the
 * browser console); the person looking at this slot is told what it means for
 * THEM. Same treatment as the grant-set card (`refusalCopy`) and the
 * apps page (`refusalSentence`).
 */
function loadFailureCopy(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  if (code === "forbidden") return "You don’t have access to this view.";
  if (code === "not-found") return "This view isn’t available any more.";
  if (code === "cloud-required") return "This view isn’t turned on for this workspace yet.";
  return "Something on our side didn’t answer — nothing changed.";
}

/** The terminal load failure. useApp already spent its retries, so this is a
 *  dead end until the user asks again — and without a way to ask, the slot sat
 *  on its skeleton until a page reload (Keystone graduates A5). */
function SlotLoadFailed({ reason, onRetry }: { reason: Error; onRetry(): void }) {
  return (
    <div className="fl-slot-ghost">
      <GhostSkeleton />
      <span className="fl-slot-cta" role="alert">
        <span className="fl-slot-cta-label">This view didn’t load</span>
        <small>{loadFailureCopy(reason)}</small>
        <button type="button" className="fl-invite-btn" onClick={onRetry}>Try again</button>
      </span>
    </div>
  );
}

/**
 * The terminal BUILD failure of the app placed here.
 *
 * Two remedies, both honest: ask again — offered ONLY when the failed record
 * kept the original request, because re-issuing anything else is a different
 * build wearing this one's name — and clear the slot, which is the unplace the
 * host's own markup comes back from.
 *
 * The wire's `reason` never reaches this page (§16 law 3, same law as the
 * embed's): every one of those sentences names a component, an expression or an
 * env var, and this is a host's own page. The developer sentence keeps the home
 * it has — the server's `[vendo] app build failed (app_…)` log line.
 */
function SlotBuildFailed({ appId, slotId, onChanged }: {
  appId: string;
  slotId: string;
  onChanged(): void;
}) {
  const { client } = useVendoProvider();
  const [failure, setFailure] = useState<{ retryable?: boolean; prompt?: string }>();
  const [busy, setBusy] = useState(false);

  // ONE read, not a poll: the record is terminal. The status already came from
  // the placements read; this is only the retry affordance's evidence.
  useEffect(() => {
    let cancelled = false;
    setFailure(undefined);
    void client.apps.open(appId, { pending: true }).then(
      surface => { if (!cancelled && surface.kind === "failed") setFailure(surface); },
      () => { /* the record is failed either way; without detail there is no retry */ },
    );
    return () => { cancelled = true; };
  }, [appId, client]);

  const retry = async () => {
    const prompt = failure?.prompt;
    if (prompt === undefined) return;
    setBusy(true);
    try {
      const created = await client.apps.create({ prompt });
      // The affordance AWAITS the placement itself, so the slot showing the new
      // build is a fact rather than a hope.
      await client.apps.place(created.id, slotId);
      announcePin(created.id);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await client.apps.unplace(appId, slotId);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div className="fl-slot-ghost">
      <GhostSkeleton />
      <span className="fl-slot-cta" role="alert">
        <span className="fl-slot-cta-label">This view didn’t build</span>
        <small>{BUILD_FAILURE_COPY}</small>
        {failure?.retryable === true && failure.prompt !== undefined ? (
          <button type="button" className="fl-invite-btn" disabled={busy} onClick={() => void retry()}>
            Try again
          </button>
        ) : null}
        <button type="button" className="fl-invite-own" disabled={busy} onClick={() => void clear()}>
          Clear this slot
        </button>
      </span>
    </div>
  );
}

function MountedApp({ appId }: { appId: string }) {
  const { client, components } = useVendoProvider();
  const { surface, error, isLoading, refresh } = useApp(appId);
  // Wave 7 H2 — the served-surface keepalive: an on-screen embed pings the
  // machine (host-proxied) so a served app doesn't idle out under the user.
  const keepalive = useMemo(
    () => ({ ping: () => client.apps.pingMachine(appId) }),
    [appId, client],
  );
  if (!surface) {
    if (error && !isLoading) return <SlotLoadFailed reason={error} onRetry={() => void refresh()} />;
    return <SlotGhost label="Loading app…" loading />;
  }
  return <AppFrame key={appId} surface={surface} components={components} keepalive={keepalive} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
}

/** A generated view pinned into a slot (08-ui §4 — "or a pinned component").
 *  Unlike an app (a whole document), a pin is a single `vendo-genui/v2` tree the
 *  user authored and pinned in place; it mounts through the same tree renderer +
 *  error boundary, falling back to the host's original markup if it throws. */
export interface VendoSlotPin {
  /** The pinned generated view (a `vendo-genui/v2` tree payload). */
  payload: UIPayload;
  /** Live data overriding the tree's embedded data model (08-ui §5). */
  data?: Record<string, Json>;
  /** Action dispatch for the pinned component; defaults to the tree renderer's
   *  fail-soft no-op when a pin carries no live handler. */
  onAction?(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
}

/** 08-ui §4; 06-apps §8 — inline mount that never sacrifices host fallback content.
 *
 *  A slot's one job is mounting brand-new generated apps (2026-08-02 final
 *  shape — remix lives entirely on `<Remixable>` now). Three states:
 *  - empty: no `appId`, no `pin`, no `children` → the ghost with a REAL CTA button
 *    that opens the authoring surface (`onAuthor`, else the mounted ⌘K palette);
 *  - app: `appId` → the whole app document mounts (via the single-app transport);
 *  - pinned component: `pin` → the authored `vendo-genui/v2` view mounts in place.
 *
 *  In both filled states the swap morphs through the ENG-205 render slot, using
 *  the host's own markup as the exit frame, and the PinMount error boundary keeps
 *  the original `children` as the visible recovery path (06-apps §8). Without any
 *  of the three, the children render UNTOUCHED (no wrapper — hosts may inline
 *  slots anywhere). */
export function VendoSlot({ id, appId: appIdProp, pin, onAuthor, discover = true, emptyState, children }: {
  id: string;
  appId?: string;
  pin?: VendoSlotPin;
  /** Invoked when the empty-state CTA is activated — the seam to open a thread
   *  or palette to author the view. Defaults to opening a mounted VendoPalette. */
  onAuthor?(slotId: string): void;
  /** Pass `false` to stand pin self-discovery down even with no `appId`/`pin`
   *  prop — for hosts that resolve the pin themselves (e.g. via useSlotApp
   *  for a layout decision) and must not start a second poll. */
  discover?: boolean;
  /** Empty-state invitation config (ui-lane-entry pick S-A×S-D). Every string
   *  is host-customizable with white-label defaults; suggestions are 3
   *  host-aware prompts (generic fallbacks otherwise) whose tap PREFILLS the
   *  conversation composer — never sends. */
  emptyState?: {
    /** Default "This space builds itself". */
    title?: string;
    /** Default "describe a view — it renders here, live on your data". */
    subtitle?: string;
    /** Up to 3 prompt chips. Default: generic view-authoring prompts. */
    suggestions?: string[];
    /** Primary button label (layout "button"). Default "Design a view". */
    ctaLabel?: string;
    /** "button" (chips + primary CTA, default) or "chips-first" (chips are
     *  the actions; a quiet "or describe your own…" link opens the composer). */
    layout?: "button" | "chips-first";
    /** Optional mark above the title. Default "none" (Yousef's pick). */
    mark?: "none" | "sparkle" | "tile";
  };
  children?: ReactNode;
}) {
  const { components } = useVendoProvider();
  // Self-discovery (ui-usage-dx §2): with no explicit `appId`/`pin`, the slot
  // resolves its own pinned app — hosts never write the polling dance.
  const discovery = useSlotApp(id, { enabled: discover && appIdProp === undefined && pin === undefined });
  // Only a READY app mounts: a placement can name a build that is still
  // forming (or that failed), and opening an app with no document yet is a
  // guaranteed "this view didn't load". The host's own children stay up until
  // there is something real to swap in.
  const appId = appIdProp ?? (pin === undefined && discovery.status === "ready" ? discovery.appId : undefined);
  // An explicit `appId`/`pin` prop is the host asserting the slot's contents:
  // it carries no build status of its own, and a placement written into it
  // would never be read.
  const resolvesItself = appIdProp === undefined && pin === undefined;
  // The placed app's own build status — discovery's, and only discovery's.
  const status = resolvesItself ? discovery.status : undefined;

  // A slot id lives in the host's markup and nowhere else, so a surface that is
  // not on this page (the embed's "Add to…" picker) can only learn this slot
  // exists from here. Every state of a self-resolving slot notes it, including
  // the untouched-children one; a host-asserted one stays out of the picker
  // rather than promising a landing the person would never see.
  useEffect(() => {
    if (!resolvesItself) return;
    noteSlot({ id, label: slotLabel(id) });
  }, [id, resolvesItself]);

  const author = () => {
    if (onAuthor) {
      onAuthor(id);
      return;
    }
    // One-surface model (pick P-C): authoring opens the conversation overlay
    // with the composer focused. The palette-opener fallback keeps hosts that
    // mounted only a VendoPalette (custom onCommand routing) working.
    if (!openVendoConversation()) openVendoPalette();
  };

  // Suggestion chips prefill the composer — never send (safe on any prompt).
  // No palette-opener fallback here: it cannot carry the prompt, so it would
  // open an empty surface and silently drop the chip's text (cubic PR#391
  // finding). Without an overlay the chip is a dev-warned no-op instead.
  const suggest = (prompt: string) => {
    const opened = openVendoConversation({ prompt, send: false });
    if (!opened && developmentMode()) {
      console.warn(`[vendo] VendoSlot "${id}": suggestions open the conversation surface — mount a VendoOverlay for them to land in.`);
    }
  };

  // A build that will never land. `discovery.appId`, not `appId`: only a READY
  // placement resolves into a mountable app id, and this one never will.
  if (status === "failed" && discovery.appId !== undefined) {
    return (
      <ChromeRoot>
        <div className="fl-slot" data-vendo-slot={id}>
          <SlotBuildFailed appId={discovery.appId} slotId={id} onChanged={() => void discovery.refresh()} />
        </div>
      </ChromeRoot>
    );
  }

  if (!appId && !pin) {
    if (children !== undefined) return <>{children}</>;
    // A placement row is written the moment the app id is minted, so a slot
    // with no markup of its own says what is coming instead of inviting a
    // second ask — the skeleton the empty state already uses, minus the
    // invitation. BEHIND the children arm above, deliberately: a working host
    // component must never blank into a skeleton for the length of a build.
    // The conversation surface carries that beat for the person who asked.
    if (status === "building") {
      return (
        <ChromeRoot>
          <div className="fl-slot" data-vendo-slot={id}>
            <SlotGhost label="Building your view…" loading />
          </div>
        </ChromeRoot>
      );
    }
    // The invitation (pick S-A×S-D): accent-washed surface, real copy, up to
    // three concrete suggestion chips, and (layout "button") a primary CTA.
    // The skeleton stays behind at low opacity so it still reads as "a view
    // goes here". No icon by default.
    const invite = {
      title: emptyState?.title ?? "This space builds itself",
      subtitle: emptyState?.subtitle ?? "describe a view — it renders here, live on your data",
      suggestions: (emptyState?.suggestions ?? defaultSlotSuggestions).slice(0, 3),
      ctaLabel: emptyState?.ctaLabel ?? "Design a view",
      layout: emptyState?.layout ?? "button",
      mark: emptyState?.mark ?? "none",
    };
    return (
      <ChromeRoot>
        <div className="fl-slot" data-vendo-slot={id}>
          <div className="fl-slot-ghost fl-slot-invite">
            <GhostSkeleton />
            <div className="fl-slot-cta" role="group" aria-label={invite.title}>
              {invite.mark !== "none" ? (
                <span className={`fl-invite-mark${invite.mark === "tile" ? " fl-invite-mark-tile" : ""}`} aria-hidden="true">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" />
                    <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
                  </svg>
                </span>
              ) : null}
              <span className="fl-invite-title">{invite.title}</span>
              <small className="fl-invite-sub">{invite.subtitle}</small>
              {invite.suggestions.length > 0 ? (
                <>
                  <span className="fl-invite-try">Try one</span>
                  <div className="fl-invite-chips">
                    {invite.suggestions.map((prompt, i) => (
                      <button type="button" className="fl-invite-chip" key={`${i}-${prompt}`} onClick={() => suggest(prompt)}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {invite.layout === "button" ? (
                <button type="button" className="fl-invite-btn" onClick={author}>{invite.ctaLabel}</button>
              ) : (
                <button type="button" className="fl-invite-own" onClick={author}>or describe your own…</button>
              )}
            </div>
          </div>
        </div>
      </ChromeRoot>
    );
  }

  const Fallback = () => <>{children}</>;
  const mounted = appId
    ? <MountedApp appId={appId} />
    : <AppFrame surface={{ kind: "tree", payload: pin!.payload }} components={components} data={pin!.data} onAction={pin!.onAction} />;
  return (
    <ChromeRoot>
      <div className="fl-slot" data-vendo-slot={id}>
        <div className="fl-slot-filled">
          <FluidReveal stateKey={appId ? `app:${appId}` : `pin:${id}`} initialExit={children}>
            <PinMount slot={id} fallback={Fallback}>{mounted}</PinMount>
          </FluidReveal>
        </div>
      </div>
    </ChromeRoot>
  );
}
