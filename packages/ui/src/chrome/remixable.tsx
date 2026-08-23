import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { log, type AppDocument, type AppId, type Json } from "@vendoai/core";
import { useVendoProvider } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { useAppSharing } from "../hooks/use-app-sharing.js";
import { useResource } from "../hooks/use-resource.js";
import { FluidReveal } from "../tree/fluid-reveal.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import type { InClientVenue } from "../wire-types.js";
import { useApprovalModal } from "./approval-modal.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";
import { GRACE_MS, PinChrome, useMenuDismiss } from "./pin-chrome.js";
import { vendoToast } from "./vendo-toasts.js";

/**
 * The remixable-surface affordance: the host marking one of its own components
 * as remixable. The ✦ is ONE DOOR — it opens the conversation the page already
 * has, about this component, and the person types their wish there. It used to
 * open a wish form of its own, which was a second place to ask the same
 * question: the chat could answer, show its work, and say when a remix failed;
 * the form could only mint and go quiet.
 *
 * The remix that conversation makes mounts IN PLACE, replacing the wrapped
 * child at this boundary for that user only. Until its screen is ready the
 * host's own live original stays on the page.
 *
 * At rest a 9px muted ✦ seed sits inside the wrapped element's top-right
 * corner — visible if you look for it, invisible while you are working.
 * Pointing at the element blooms that seed IN PLACE into the ✦ pill — same
 * corner, same optical centre — so it reads as one mark opening rather than a
 * glyph swapping for a button. On an unremixed surface the pill IS the door;
 * on a remixed one it is the pin chrome (pin-chrome.tsx), because a remix is a
 * pinned app and one ✦ menu is the whole point.
 *
 * REVEALED IS STATE, NOT `:hover`. A CSS-only reveal dies the instant the
 * cursor leaves the box, which is exactly what it does on the way to the pill
 * — so the pill could never be clicked. One boolean instead, and pointer-leave
 * only clears it after a grace period the next pointer-enter cancels. Focus
 * reveals it the same way (focus and blur bubble on this div), so it stays
 * keyboard-reachable.
 */

const DISCOVERY_POLL_MS = 5000;

export interface RemixableProps {
  /** The review-kind flag (capture metadata — sync writes it into the
   *  baseline). Review buys the venue, never visibility: a reviewed
   *  component's approved fork mounts natively; an instant (default) one
   *  renders sandboxed, forever, with no review process at all. The gating
   *  itself is server-side — here it only holds the host's own component on
   *  the page until the verdict arrives. */
  review?: boolean;
  children: ReactNode;
}

/** The slot name is the wrapped component's identifier — the same exported
 *  name `vendo sync` captures the baseline under. Inline JSX or a plain
 *  element is a loud sync-time error, so at runtime it simply gets no
 *  affordance.
 *
 *  MINIFICATION: a production bundle erases `Function.name`, so a wrapped
 *  component must carry React's canonical `displayName` (set to its exported
 *  identifier) for the affordance to exist in production builds — dev always
 *  resolves, which is exactly why the gap is easy to miss. Flagged to the
 *  driving session for sync-time enforcement. */
function slotOf(children: ReactNode): string | null {
  if (!isValidElement(children) || typeof children.type === "string") return null;
  const type = children.type as { displayName?: string; name?: string };
  const name = type.displayName ?? type.name ?? "";
  return /^[A-Z]/.test(name) ? name : null;
}

/** JSON-serializable check for the fork's props snapshot. Functions, elements,
 *  symbols, and class instances (Dates included) are dropped SILENTLY: host
 *  functions never cross the frame boundary — behavior is rewired through the
 *  host's API instead. */
const isSerializable = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSerializable);
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(isSerializable);
  }
  return false;
};

/** The wrapper's serializable live props — the fork call's `props` payload
 *  (stored server-side as the fork's dashboard seed) and what flows into the
 *  mounted fork on every render. */
function serializableProps(children: ReactNode): Record<string, Json> {
  if (!isValidElement(children)) return {};
  const props = children.props as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(props).filter(([, value]) => isSerializable(value)),
  ) as Record<string, Json>;
}

const NO_APPS: AppDocument[] = [];

/** What a BUILD writing this app leaves on its document: the code it saved, and
 *  whether it is still saving (`AppDocument.source` / `.building`). Nothing else
 *  on the document moves per read, so a mark that changes means a build landed —
 *  and a settled mark means there is nothing to re-read. */
function buildMark(app: AppDocument | undefined): string {
  return `${app?.building ?? ""}|${Object.values(app?.source ?? {}).map(file => file.hash).join()}`;
}

/** Remix discovery: the user's remix for this component is the app whose `seed`
 *  names it (provenance — the 2026-08-02 provenance/placement split). An
 *  in-place remix needs no placement: its location IS the wrapper it replaced,
 *  so this reads the seed, never placements.
 *
 *  The OLDEST matching row wins, and deliberately: `.at(-1)` over a newest-first
 *  list keeps the wrapper and the server on the same app whenever a component
 *  somehow carries two. (This comment used to say "latest wins, like slot
 *  discovery"; slot discovery genuinely meant latest and was reading the oldest
 *  — see use-slot-app.ts. Here the code was right and the comment was wrong.) */
function useRemixFork(slot: string | null) {
  const { client } = useVendoProvider();
  const list = useCallback(
    () => (slot === null ? Promise.resolve(NO_APPS) : client.apps.list()),
    [client, slot],
  );
  const { data, refresh } = useResource(list, NO_APPS, { pollMs: slot === null ? 0 : DISCOVERY_POLL_MS });
  const fork = data.filter(app => app.seed?.component === slot).at(-1);
  return { appId: fork?.id, build: buildMark(fork), refresh };
}

function RemixedFork({ appId, slot, review, build, liveProps, original, onReverted }: {
  appId: string;
  slot: string;
  review: boolean;
  build: string;
  liveProps: Record<string, Json>;
  original: ReactNode;
  onReverted(): Promise<void>;
}) {
  const { client, components } = useVendoProvider();
  const { surface, error, isLoading, refresh } = useApp(appId);
  // A press inside the mounted fork that parks on the guard asks its question
  // over this surface (the VendoSlot seam). The modal hangs off the ✦ chrome
  // below rather than the fork's own boundary: it must outlive a fork that
  // unmounts (a revert) while a decision is still in flight.
  const approval = useApprovalModal();

  // THE BUILD THAT LANDS LATE. A remix's screen is rebuilt long after its row
  // exists: the seed paints the ported original first and turns it into the
  // wish seconds later, and every edit the chat runs does the same again.
  // `useApp` re-reads only while the answer is still pending, so a surface that
  // settled on the port kept painting it until the person reloaded the page.
  // The mark rides the discovery poll the wrapper already runs — no request of
  // its own, and nothing to re-read once the app stops being built.
  const built = useRef(build);
  useEffect(() => {
    if (build === built.current) return;
    built.current = build;
    void refresh();
  }, [build, refresh]);

  useEffect(() => {
    if (!isLoading && error !== undefined && developmentMode()) {
      log({
        code: "ui.remixable-fork-load-failed",
        level: "warn",
        message: `[vendo] Remixable "${slot}": the fork failed to load — ${error.message}`,
      });
    }
  }, [error, isLoading, slot]);

  // THE COURIER. The live serializable props from the call site go to the
  // SERVER, on mount and again whenever they change, and the server repaints the
  // remix on them (`AppSeed.props`; the checks floor's props resolver in
  // apps/doors/build-surface.ts). Then re-open, because the paint is what
  // changed and the surface is what holds it.
  //
  // This used to be a client-side splice: clone the payload, find the node named
  // `seedComponentName(slot)` with `source: "generated"`, and merge the props
  // onto it. That node does not exist. A remix is a ported SCREEN, whose tree is
  // whatever rendering it produced — display bricks marked `source: "ported"` —
  // and `seedComponentName` names a seat in `document.components`, never a node
  // (apps/doors/write-surface.ts). So the find never matched, the merge never
  // ran, and the remix painted the values `vendo sync` captured while the host's
  // own component beside it painted today's. Deleted rather than repaired: the
  // props have to reach the server anyway, because the screen is painted there.
  //
  // Keyed on content, so a host re-rendering for its own reasons couriers
  // nothing and an unchanged call site costs one comparison.
  const livePropsKey = JSON.stringify(liveProps);
  // What the server actually KEPT last time. Re-opening is what makes the new
  // paint visible, and it re-runs the whole checks floor — so it is spent only
  // when the stored props really moved. The wrapper ships every serializable
  // prop the call site passes, and the door keeps only the ones the captured
  // baseline declares; without this, a host prop the component never declared
  // (a timestamp, a callback's changing identity) would buy a full server
  // repaint on every tick and change nothing on screen.
  const stored = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void client.apps.courierProps(appId as AppId, JSON.parse(livePropsKey) as Record<string, Json>)
      .then((next) => {
        const kept = JSON.stringify(next.seed?.props ?? {});
        if (!live || kept === stored.current) return undefined;
        stored.current = kept;
        return refresh();
      })
      // A courier that does not land leaves the remix on the props it already
      // had — the last good paint, never a blank one — and the page is not the
      // place to report it.
      .catch(() => undefined);
    return () => { live = false; };
  }, [client, appId, livePropsKey, refresh]);

  // The founder's binding rule (2026-08-02): until a reviewer approves, the
  // ORIGINAL host component stays rendered, untouched. A pending or rejected
  // review-kind remix mounts NOTHING here — no AppFrame, no notice in the
  // page; its status lives in the conversation that asked for it. The venue
  // verdict is server-authoritative ("pending-review" ships no executable
  // source); the wrapper's own `review` flag covers a payload with no venue.
  const venue = surface?.kind === "tree" ? (surface.payload as { inClient?: InClientVenue }).inClient : undefined;
  const underReview = venue?.granted !== true
    && (review || (venue !== undefined && !venue.granted && venue.reason === "pending-review"));

  // Until the fork's surface arrives (or if it never does), the original child
  // is the honest content — the wrapper never trades working host markup for
  // a skeleton, and a crashing fork drops back to it (PinMount). A remix that
  // never builds gets NO surface of its own here: the wish was typed in the
  // chat, so the failure is the chat's to report (the thread's build-failed
  // beat), and a second error surface on the page is what S2 deleted.
  //
  // What the ✦ itself says is a different question, and deleting that surface
  // took the answer with it. The provenance row lands the instant the remix is
  // minted and its screen arrives tens of seconds later, so through the whole
  // build — and forever, when the build terminally fails — the mark sat over
  // the host's untouched original reading a settled "Edit", offering to edit a
  // screen that does not exist. Read off the SAME open payload the mount waits
  // on, so the mark and the page can never disagree.
  const pending = surface === undefined && error === undefined;
  const failed = surface?.kind === "failed" || (surface === undefined && error !== undefined);
  const state = pending
    ? { label: "Remixing…", name: "Remixing this view…", status: "Making your remix.", busy: true }
    : failed
      ? { label: "Didn’t load", name: "This view didn’t load", status: "The remix didn’t load — the chat that asked for it says why." }
      : undefined;
  const Original = () => <>{original}</>;
  const sharing = useAppSharing(appId as AppId);
  // "Update" REPLAYS the recorded wishes onto the host's new version — that is
  // what the seed is FOR, and the menu item said so while doing nothing but a
  // round trip. With no new version there is nothing to replay (the server
  // refuses that as a conflict), so it stays the round trip it always was.
  const drifted = surface?.kind === "tree" && (surface.payload as { seedDrift?: unknown }).seedDrift !== undefined;
  const update = () => {
    if (!drifted) return void refresh();
    void client.apps.reseed(appId).then(() => refresh(), () => {
      vendoToast({ text: "That didn’t go through — try again.", state: "error" });
    });
  };
  return (
    <ChromeRoot>
      <PinChrome
        appId={appId}
        // A PINNED APP arrives here with a name the person chose; a remix has
        // only `slot`, the React identifier sync captures under, which appears
        // nowhere else on their page. So this side says what the unremixed ✦
        // says — and it matches the pill's own visible word, which is the name
        // a voice-control user can actually speak.
        title="this view"
        {...(state === undefined ? {} : { state })}
        {...(sharing === undefined ? {} : { sharing })}
        // The grounding rides `context` — a marked text part on the sent
        // message that no surface renders — so the prefill can name the THING
        // and never an id (spec §16 law 3).
        context={`The view being remixed is the "${slot}" slot, app ${appId}.`}
        onRefresh={update}
        onRevert={() => client.apps.delete(appId).then(onReverted)}
      >
        {surface?.kind === "tree" && !underReview ? (
          <FluidReveal stateKey={`fork:${appId}`} initialExit={original}>
            <PinMount slot={slot} fallback={Original}>
              <AppFrame
                surface={surface}
                components={components}
                onParked={approval.onParked}
                onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})}
              />
            </PinMount>
          </FluidReveal>
        ) : original}
      </PinChrome>
      {approval.modal}
    </ChromeRoot>
  );
}

export function Remixable({ review = false, children }: RemixableProps) {
  const { remixSlots } = useVendoProvider();
  const [revealed, setRevealed] = useState(false);
  const root = useMenuDismiss(revealed, setRevealed);
  const grace = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(grace.current), []);

  const slot = slotOf(children);
  const { appId, build, refresh } = useRemixFork(slot);

  useEffect(() => {
    if (slot === null && developmentMode()) {
      log({
        code: "ui.remixable-invalid-child",
        level: "warn",
        message: "[vendo] <Remixable> must wrap exactly one statically importable component element; extract a component and wrap that (vendo sync says the same, loudly).",
      });
    }
  }, [slot]);

  if (slot === null) return <>{children}</>;

  const reveal = () => {
    window.clearTimeout(grace.current);
    setRevealed(true);
  };
  const release = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => setRevealed(false), GRACE_MS);
  };

  // ONE DOOR: the ✦ opens the conversation about this component, prefilled and
  // unsent, and the person finishes the sentence there. It mints nothing —
  // what a remix should do is the agent's question to answer, and its progress
  // and its failures belong in the same thread as the asking.
  const openChat = () => {
    const opened = openVendoConversation({
      // The person never sees `slot` anywhere else on the page — it is the
      // React identifier sync captures under, and it read as a leaked internal
      // to the first person who clicked this. The AGENT still gets it verbatim,
      // in the context below, which is where a name it must echo belongs.
      prompt: "Remix this view: ",
      context: `The view being remixed is the host component "${slot}". When you make the remix, pass component=${slot} verbatim.`,
      send: false,
    });
    if (!opened && developmentMode()) {
      log({
        code: "ui.remixable-no-overlay",
        level: "warn",
        message: `[vendo] Remixable "${slot}": ✦ opens the conversation surface — mount a VendoOverlay for it to land in.`,
      });
    }
  };

  return (
    // data-vendo-remixable marks the element's real boundary: the fork's mount
    // point, and where a pin's ghost flies back into.
    <div
      className="fl-remixable"
      data-vendo-remixable={slot}
      ref={root}
      {...(revealed ? { "data-vendo-revealed": "" } : {})}
      onPointerEnter={reveal}
      // Only a CURSOR leaves. A touch pointer's leave fires the instant the
      // finger lifts, which would take the pill away with the tap that asked
      // for it; the outside-press above is touch's dismissal.
      onPointerLeave={event => { if (event.pointerType === "mouse") release(); }}
      onFocus={reveal}
      onBlur={release}
    >
      {appId !== undefined ? (
        <RemixedFork
          appId={appId}
          slot={slot}
          review={review}
          build={build}
          liveProps={serializableProps(children)}
          original={children}
          onReverted={refresh}
        />
      ) : !remixSlots.has(slot) ? (
        // No port, no offer. The generated wiring names the slots sync could
        // split, and a slot it does not name has nothing for a fork to start
        // from — sync already said why, loudly, in its report. So the host's
        // own markup renders alone: not a disabled ✦, not a greyed one, none.
        // The gate is on the OFFER only; the arm above still mounts and still
        // manages a remix that already exists, because revert is the way back.
        children
      ) : (
        <>
          {children}
          <ChromeRoot className="fl-remixable-chrome">
            <span className="fl-remix-seed" aria-hidden="true">✦</span>
            <button
              type="button"
              className="fl-remix-pill"
              aria-label="Remix this view with Vendo"
              onClick={openChat}
            >
              <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
              Remix
            </button>
          </ChromeRoot>
        </>
      )}
    </div>
  );
}
