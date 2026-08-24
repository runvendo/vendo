/**
 * The screen-initiated approval modal.
 *
 * THE DEFECT this exists for: a money-moving button on a generated screen that
 * parked on the guard had no UI anywhere — only a badge count somewhere else on
 * the page — so the person who pressed it waited forever for something that was
 * never going to happen without them. This is that press's answer: the ask,
 * centered over the page, decided or dismissed on the spot.
 *
 * Its own composition rather than `<ApprovalCard>` in a box. The card is a ROW
 * — one item in a thread or a queue — and this is the confirmation moment a
 * deliberate press earned, so it wears the ask at hero size. The WORDS still
 * come from the one shared ladder (`toolPresentation` → `consentAsk`, ruling
 * 14), so a modal and a thread card can never say different things about one
 * ask, and the inputs still ride `CardFields` — the honesty law's one body.
 *
 * Three rules the surface is built around:
 *  · Esc and the scrim CLOSE, they never decide. An approval is spent by
 *    pressing Approve or Deny and by nothing else; dismissed, it stays pending
 *    and comes back from the badge or the next press.
 *  · While a decision is in flight there is no exit. `approvals.decide` does not
 *    return until the approved action has actually RUN server-side (~25s in
 *    production today), so the modal shows that plainly instead of freezing a
 *    button or pretending it finished.
 *  · Focus lands on the DIALOG, never on Approve — the keystroke that opened
 *    this modal must not be able to spend the decision it came here to ask for.
 */
import type { ApprovalId } from "@vendoai/core";
import type { ParkedPress } from "../tree/renderer.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { APPROVALS_DECIDED_EVENT, type ApprovalsDecidedDetail } from "../client-impl.js";
import { useVendoProvider, useVendoTools } from "../context.js";
import { themeCssVariables } from "../theme.js";
import type { ApprovalResolution } from "../wire-types.js";
import { refusalCopy } from "./approval-card.js";
import { consentAsk, toolPresentation } from "./build-beat.js";
import { CARD_EYEBROWS, CardFields, NOTE_SEPARATOR } from "./card-shell.js";
import { ensureChromeStyles, useChromeTheme } from "./chrome-root.js";
import { fieldRows } from "./field-rows.js";
import { inertBehind } from "./inert-behind.js";

/** Long enough for the exit to play, short enough that a decided modal is gone
    before the eye looks for it. Kept in step with `fl-apmodal-out`. */
const EXIT_MS = 170;

const FOCUSABLE = "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

/** The ask is no longer waiting on this person — every reason, in their words.
    Never a silent close: they pressed a button and are owed the outcome. */
const SETTLED: Record<string, string> = {
  executed: "This already went through.",
  declined: "This was already declined.",
  expired: "This request expired — try the action again.",
};

/** A press inside a generated view that parked on the guard — the tree's own
    shape for it (`ParkedPress`), under the name this surface asks the question in. */
export type ParkedApproval = ParkedPress;

/**
 * The mount seam: one call gives a surface the park handler and the modal to
 * render. Deliberately not a provider or a registry — a slot owns the presses
 * inside it, so it owns the questions they raise.
 *
 * A QUEUE, because presses arrive in bursts: pressing Send on two payee rows
 * back to back parks two approvals, and two modals over one screen (let alone
 * two stacked scrims) is not a question anybody can answer. Exactly one is on
 * screen; the next presents itself once that one has left.
 */
export function useApprovalModal(): {
  onParked(parked: ParkedApproval): void;
  modal: ReactNode;
} {
  const [queue, setQueue] = useState<readonly ParkedApproval[]>([]);
  // Keyed by approval, so re-pressing a button whose ask is already waiting
  // joins nothing and asks nothing twice.
  const onParked = useCallback((next: ParkedApproval) => setQueue(current =>
    current.some(parked => parked.approvalId === next.approvalId) ? current : [...current, next]), []);
  // ONE exit for both endings — decided, or dismissed with Esc — and it drops
  // only the HEAD. Nothing is lost by dismissing: Esc never decides, so that
  // approval is still pending on the server and comes back from the badge or
  // the next press, while the asks queued behind it get their turn now.
  // (Sending it to the BACK instead would make Esc unescapable whenever it is
  // the only ask waiting — it would re-present itself forever.)
  const close = useCallback(() => setQueue(current => current.slice(1)), []);
  // An ask answered on another surface never gets a turn here. Without this,
  // someone who presses twice and then approves both from the chat card is
  // shown a modal per press, each only to say it was already handled. The HEAD
  // is deliberately exempt: the mounted modal is listening to the same event
  // and owns its own exit, and yanking it here would cut that exit short.
  useEffect(() => {
    const onDecided = (event: Event) => {
      const ids = (event as CustomEvent<ApprovalsDecidedDetail>).detail?.ids;
      if (ids === undefined) return;
      setQueue(current => current.filter((parked, index) => index === 0 || !ids.includes(parked.approvalId)));
    };
    window.addEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(APPROVALS_DECIDED_EVENT, onDecided);
  }, []);
  const head = queue[0];
  return {
    onParked,
    // Keyed by approval: the outgoing modal finishes its exit before the next
    // ask mounts and plays its own entrance, so there is never a frame with
    // two of them.
    modal: head === undefined
      ? null
      : <ApprovalModal key={head.approvalId} approvalId={head.approvalId} onClose={close} />,
  };
}

export function ApprovalModal({ approvalId, onClose }: {
  approvalId: ApprovalId;
  /** Fires once the exit has played — the caller unmounts here. */
  onClose(): void;
}) {
  const { client } = useVendoProvider();
  // The ask belongs to the surface the press came from, so it wears THAT
  // surface's theme — a slot or embed with its own `theme` prop, not just the
  // provider's. The layer below portals to <body>, so the boundary that themes
  // the spawning surface can only reach it through React context.
  const theme = useChromeTheme();
  const tools = useVendoTools();
  const [resolution, setResolution] = useState<ApprovalResolution>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [deciding, setDeciding] = useState<"approve" | "deny">();
  const [error, setError] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(ensureChromeStyles, []);

  useEffect(() => {
    let cancelled = false;
    void client.approvals.get(approvalId).then(
      answer => { if (!cancelled) setResolution(answer); },
      () => { if (!cancelled) setLoadFailed(true); },
    );
    return () => { cancelled = true; };
  }, [approvalId, client]);

  // Answered on another surface sharing this page (the thread card, a host's
  // own queue): the question is settled, so the modal leaves rather than
  // asking it a second time. Our own decide announces through the same event.
  useEffect(() => {
    const onDecided = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalsDecidedDetail>).detail;
      if (detail?.ids.includes(approvalId) === true) setLeaving(true);
    };
    window.addEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(APPROVALS_DECIDED_EVENT, onDecided);
  }, [approvalId]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onClose, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onClose]);

  // Modal semantics. `position: fixed` and a scrim stop the mouse; only `inert`
  // stops the keyboard and the screen reader from walking into the page
  // underneath — which is also what keeps Tab inside the dialog.
  useEffect(() => {
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const release = inertBehind(layerRef.current);
    return () => {
      release();
      body.style.overflow = previousOverflow;
    };
  }, []);

  // The dialog itself takes focus, and the opener gets it back on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const detail = useMemo(() => {
    if (resolution?.state !== "pending") return undefined;
    const { request } = resolution;
    // Pending with no ask attached: the decision is already running server-side
    // (byo-approvals.ts). The skeleton stands — there is nothing to decide here.
    if (request === undefined) return undefined;
    const meta = tools[request.call.tool];
    const presentation = toolPresentation(
      request.call.tool,
      request.call.args,
      meta,
      request.descriptor.title,
      request.descriptor.inputSchema,
    );
    const named = new Set(presentation.questionKeys ?? []);
    return {
      title: presentation.title,
      // The real inputs ride their own table below, so the shared ladder is
      // asked only for its SENTENCE half: the question, and what approving
      // does. (Passing no rows is what leaves its row half empty.)
      ask: consentAsk(request.descriptor.risk, presentation, [], meta),
      // The honesty law: every input the question does not already name is on
      // the surface, never behind a fold.
      rows: fieldRows(request.call.args, request.descriptor.inputSchema, meta)
        .filter(row => !named.has(row.key)),
    };
  }, [resolution, tools]);

  const dismiss = () => {
    // No exit mid-decision: the action is already running on the server, and
    // hiding that is worse than waiting for it.
    if (deciding === undefined) setLeaving(true);
  };

  const decide = async (approve: boolean) => {
    setDeciding(approve ? "approve" : "deny");
    setError(undefined);
    try {
      await client.approvals.decide([approvalId], { approve });
      setLeaving(true);
    } catch (reason) {
      setError(refusalCopy(reason));
      setDeciding(undefined);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const edge = event.shiftKey ? focusable[0]! : focusable.at(-1)!;
    if (document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? focusable.at(-1)! : focusable[0]!).focus();
  };

  if (typeof document === "undefined") return null;

  const settled = loadFailed
    ? "We couldn’t load this request."
    : resolution !== undefined && resolution.state !== "pending"
      ? SETTLED[resolution.state]
      : undefined;

  return createPortal(
    <div
      ref={layerRef}
      className="vendo-root fl-apmodal-layer"
      data-vendo-ignore=""
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      {...(leaving ? { "data-leaving": "" } : {})}
      style={{
        ...themeCssVariables(theme),
        fontFamily: "var(--vendo-font-family)",
        fontSize: "var(--vendo-font-size)",
      } as CSSProperties}
    >
      <div className="fl-apmodal-scrim" onClick={dismiss} />
      <div
        ref={dialogRef}
        className="fl-apmodal"
        role="dialog"
        aria-modal="true"
        aria-label={detail === undefined ? "Approval request" : `Approval for ${detail.title}`}
        tabIndex={-1}
        {...(deciding === undefined ? {} : { "data-deciding": deciding })}
        onKeyDown={onKeyDown}
      >
        {settled !== undefined ? (
          <>
            <p className="fl-apmodal-settled">{settled}</p>
            <div className="fl-apmodal-acts">
              <button type="button" className="fl-btn fl-apmodal-deny" onClick={dismiss}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="fl-apmodal-eyebrow">{CARD_EYEBROWS.waiting}</div>
            {detail === undefined ? (
              // The press deserves an instant surface, so the modal arrives
              // whole and the ask fills in — never a blank frame, never a
              // spinner where the sentence is about to be.
              <p className="fl-apmodal-ask" role="status" aria-label="Loading this request">
                <span className="fl-apmodal-skel" style={{ width: "84%" }} />
                <span className="fl-apmodal-skel" style={{ width: "52%", marginTop: "9px" }} />
              </p>
            ) : (
              <>
                <h2 className="fl-apmodal-ask">{detail.ask.question}</h2>
                {/* One line to the eye, a LIST to a screen reader — the card's
                    own treatment, `NOTE_SEPARATOR` and all. */}
                <ul className="fl-approval-sub fl-apmodal-notes" aria-label="What approving does">
                  {detail.ask.notes.map((note, index) => (
                    <li key={index}>{index > 0 ? NOTE_SEPARATOR : null}{note}</li>
                  ))}
                </ul>
                <CardFields rows={detail.rows} />
              </>
            )}
            {error ? <div role="alert" className="fl-error">{error}</div> : null}
            <div className="fl-apmodal-acts">
              <button
                type="button"
                className="fl-btn fl-btn-primary fl-apmodal-approve"
                disabled={detail === undefined || deciding !== undefined}
                onClick={() => void decide(true)}
              >
                {deciding === "approve" ? "Approving…" : "Approve"}
                {deciding === "approve" ? <span className="fl-apmodal-rail" aria-hidden="true" /> : null}
              </button>
              <button
                type="button"
                className="fl-btn fl-apmodal-deny"
                disabled={detail === undefined || deciding !== undefined}
                onClick={() => void decide(false)}
              >
                {deciding === "deny" ? "Declining…" : "Deny"}
              </button>
            </div>
            {deciding === "approve" ? (
              // Honest, because the POST really is the action running.
              <p className="fl-apmodal-wait" role="status">Running now — this can take a few seconds.</p>
            ) : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
