import { log } from "@vendoai/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";
import { vendoToast } from "./vendo-toasts.js";

/** Long enough for cursor travel from the element to the pill, short enough
 *  that the pill does not linger over the page. Shared with `<Remixable>`
 *  (remixable.tsx), which wears the same marks — two copies of this number is
 *  two blooms that can drift apart. */
export const GRACE_MS = 200;

/** Every ✦ popover dismisses like any menu: Escape, or pointer-down outside
 *  it. Returns the ref that marks "inside". Shared with `<Remixable>`
 *  (remixable.tsx), where it is touch's only way to put the mark away. */
export function useMenuDismiss(open: boolean, onToggle: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onToggle(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onToggle(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onToggle]);
  return ref;
}

/**
 * The ONE ✦ menu — Edit in chat · Update · Revert — over any app the page is
 * showing on the person's behalf: one someone pinned into a host slot, and one
 * a `<Remixable>` component was remixed into (remixable.tsx mounts this same
 * chrome rather than a lookalike of it, so there is one ✦ vocabulary on the
 * page instead of two that almost match).
 *
 * Only `Revert` differs by owner, so only `Revert` is injected: a pinned app's
 * placement is unplaced, a remix's whole app is deleted. Both mean the same
 * thing to the person — the host's own markup comes back.
 *
 * REVEALED IS STATE, NOT `:hover`, for the reason Remixable documents: a
 * CSS-only reveal dies on the way to the pill, so the pill could never be
 * clicked. Touch has no hover at all, so a tap on the app reveals the seed and
 * a tap anywhere else puts it away.
 *
 * `useMenuDismiss` is scoped TWICE here, which is the whole of the touch
 * behavior: the popover closes on a press outside the popover, and the mark
 * only goes away on a press outside the APP, so tapping the app cannot undo the
 * tap that revealed it.
 */

export function PinChrome({ appId, title, context, state, onRefresh, onRevert, children }: {
  appId: string;
  /** What the app calls itself — the prefill names the THING, never an id. */
  title: string;
  /** The grounding "Edit in chat" hands the agent — never rendered. */
  context: string;
  /** An app that is NOT a finished screen. The mark reads `label`, answers to
   *  `name`, and the menu announces `status` — because the ✦ sits over the
   *  host's own original in both of those states, and a settled "Edit" over one
   *  is the page claiming a screen that is not there. Absent is the ordinary
   *  settled app. Vocabulary belongs to the caller: a remix that never built and
   *  a pinned app that will not load are not the same sentence. */
  state?: { label: string; name: string; status: string; busy?: boolean };
  onRefresh(): void;
  /** Undo this app's presence on the page; rejecting keeps the popover open. */
  onRevert(): Promise<void>;
  children: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useMenuDismiss(open, setOpen);
  const root = useMenuDismiss(revealed, setRevealed);
  const grace = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(grace.current), []);

  const reveal = () => {
    window.clearTimeout(grace.current);
    setRevealed(true);
  };
  // Focus outranks the cursor: a pointer leaving while the pill (or an item in
  // its popover) still holds focus must not take the mark away from underneath
  // a keyboard. Checked when the grace runs out, not when it is armed, because
  // blur fires BEFORE focus lands on wherever it went.
  const release = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => {
      if (root.current?.contains(document.activeElement) !== true) setRevealed(false);
    }, GRACE_MS);
  };

  const edit = () => {
    setOpen(false);
    setRevealed(false);
    // The person reads the app's name, the agent reads the grounding, and
    // nothing is sent.
    const opened = openVendoConversation({ appId, prompt: `Update ${title}: `, context, send: false });
    if (!opened && developmentMode()) {
      log({
        code: "ui.pin-chrome-no-overlay",
        level: "warn",
        message: `[vendo] ✦ "${title}": "Edit in chat" opens the conversation surface — mount a VendoOverlay for it to land in.`,
      });
    }
  };

  const revert = () => {
    setBusy(true);
    void onRevert().then(
      () => {
        setOpen(false);
        setRevealed(false);
      },
      (reason: unknown) => {
        // The app is still there, so nothing here may settle as though it were
        // gone: closing the popover over an app that stayed put is the same lie
        // the pin ring used to tell from a timer. One honest line — the exact
        // sentence a refused `apps.place` shows (pin-ceremony.ts) — and the
        // popover stays open, so Revert is still under the cursor to try again.
        if (developmentMode()) {
          log({
            code: "ui.pin-chrome-revert-failed",
            level: "warn",
            message: `[vendo] ✦ "${title}": reverting ${appId} failed — ${String(reason)}`,
          });
        }
        vendoToast({ text: "That didn’t go through — try again.", state: "error" });
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div
      className="fl-slot-filled"
      ref={root}
      {...(revealed || open ? { "data-vendo-revealed": "" } : {})}
      onPointerEnter={reveal}
      // Only a CURSOR leaves. A touch pointer's leave fires the instant the
      // finger lifts, which would take the mark away with the tap that asked
      // for it; the outside-press above is touch's dismissal.
      onPointerLeave={event => { if (event.pointerType === "mouse") release(); }}
      onFocus={reveal}
      onBlur={release}
    >
      {children}
      <span className="fl-remix-seed" aria-hidden="true">✦</span>
      <div className="fl-remix-menu-wrap" ref={wrap}>
        <button
          type="button"
          className="fl-remix-pill"
          aria-label={state?.name ?? `Edit ${title}`}
          aria-haspopup="true"
          aria-expanded={open}
          aria-busy={state?.busy === true || undefined}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
          {state?.label ?? "Edit"}
        </button>
        {open ? (
          <div className="fl-remix-menu" role="group" aria-label={title}>
            {/* The state's own sentence, announced. The menu is where it lived
                before the two ✦ marks converged, and it stays a LINE rather than
                a surface: what went wrong, and what to do about it, belong to
                the conversation that asked (remixable.tsx). */}
            {state === undefined ? null : <span className="fl-remix-status" role="status">{state.status}</span>}
            <button type="button" onClick={edit}>Edit in chat</button>
            <button type="button" onClick={() => { setOpen(false); onRefresh(); }}>Update</button>
            <button type="button" className="is-danger" disabled={busy} onClick={revert}>
              {busy ? "Reverting…" : "Revert"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
