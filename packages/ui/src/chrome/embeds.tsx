import {
  VENDO_APP_REF_KIND,
  VendoError,
  parseVendoToolEnvelope,
  type ApprovalDecision,
  type ToolOutcome,
} from "@vendoai/core";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useVendoContext } from "../context.js";
import type {
  VendoAppEmbedProps,
  VendoApprovalEmbedProps,
  VendoToolResultProps,
} from "../embeds.js";
import { useResource } from "../hooks/use-resource.js";
import { AppFrame } from "../tree/frames.js";
import type { ApprovalResolution, OpenSurface } from "../wire-types.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { LONG_TEXT_CAP, truncateHead } from "./truncate.js";

/**
 * Existing-agents Lane B — the three embeds a BYO chat surface renders from
 * `vendo_*` tool outputs (frozen prop contracts in ../embeds.ts). All three
 * live inside the host's `VendoProvider` pointed at the wire: auth rides the
 * host session cookie, theme rides the `--vendo-*` tokens, and they take no
 * client/config props of their own. Failure states speak the existing
 * failed/expired vocabulary — never a silent blank.
 */

/** While the build streams the wire has nothing to serve yet, so the embed
 *  polls open(); a build that never lands resolves to the failed vocabulary
 *  instead of an eternal beat. */
const APP_POLL_MS = 1200;
const APP_BUILD_DEADLINE_MS = 5 * 60_000;
/** 0.4.5 E2E cert (defect D) — the wire client has no fetch timeout, so one
 *  hung open() used to freeze the self-scheduling poll (and with it the
 *  deadline check) forever. Each poll races this cap; a timed-out poll keeps
 *  the ordinary retry cadence. */
const APP_OPEN_TIMEOUT_MS = 15_000;

/** Settle `work` within `ms` or reject — the poll loop's hang guard. The
 *  underlying fetch is not aborted (the wire client takes no signal); the
 *  loop simply stops waiting on it. */
const withPollTimeout = <T,>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the build-status poll did not answer within ${Math.round(ms / 1000)}s`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (reason: unknown) => { clearTimeout(timer); reject(asError(reason)); },
    );
  });
/** Pending approvals re-poll so a decision made anywhere (this card, the
 *  workspace queue, another tab) resolves this embed in place. */
const APPROVAL_POLL_MS = 2500;

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

const tick = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12 4 4L19 6" />
  </svg>
);

const cross = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/** One resolved line in the thread's beat vocabulary: tick for done, x for
 *  failed/terminal, orb while working. */
function BeatLine({ state, children }: { state: "working" | "done" | "error"; children: ReactNode }) {
  return (
    <div className={`fl-beat fl-beat-${state}`}>
      {state === "working" ? (
        <span className="fl-beat-orb" aria-hidden="true" />
      ) : (
        <span className={`fl-beat-ic ${state === "done" ? "fl-beat-tick" : "fl-beat-x"}`}>
          {state === "done" ? tick : cross}
        </span>
      )}
      <span className="fl-beat-label">{children}</span>
    </div>
  );
}

/** The resolved approval card: same `fl-approval` boundary as the consent
 *  card, collapsed to its terminal line (and the executed result, if any). */
function ResolvedApprovalCard({ summary, ok, line, detail }: {
  summary: string;
  ok: boolean;
  line: string;
  detail?: ReactNode;
}) {
  return (
    <article className={`fl-approval${ok ? " fl-approval-approved" : ""}`} aria-label={`Approval — ${line}`}>
      <div className="fl-approval-head">
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">Approval</div>
          <div className="fl-approval-title">{summary}</div>
        </div>
      </div>
      <BeatLine state={ok ? "done" : "error"}>{line}</BeatLine>
      {detail}
    </article>
  );
}

function executedCard(summary: string, outcome: ToolOutcome): ReactNode {
  if (outcome.status === "ok") {
    const preview = JSON.stringify(outcome.output);
    const detail = preview !== undefined && preview !== "{}" && preview !== "null"
      ? (
          <pre className="fl-approval-fields" aria-label="Result" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {truncateHead(preview, Math.min(500, LONG_TEXT_CAP))}
          </pre>
        )
      : undefined;
    return <ResolvedApprovalCard summary={summary} ok line="Approved — ran" detail={detail} />;
  }
  // The resumed call itself failed (error/blocked/…): the honest record, in
  // the thread's existing "couldn't finish" vocabulary.
  const reason = outcome.status === "error"
    ? outcome.error.message
    : outcome.status === "blocked"
      ? outcome.reason
      : outcome.status;
  return (
    <ResolvedApprovalCard
      summary={summary}
      ok={false}
      line="Approved — couldn't finish"
      detail={<div className="fl-approval-more">{reason}</div>}
    />
  );
}

/**
 * Approve/deny for a guarded call parked from a BYO agent loop
 * (`vendo/approval-ref@1`). The wire owns the state — this embed polls
 * `GET /approvals/:id` and resolves in place to the executed outcome,
 * "declined", or "expired" (the frozen `VendoApprovalEmbedState` vocabulary).
 */
export function VendoApprovalEmbed({ refValue }: VendoApprovalEmbedProps) {
  const { client } = useVendoContext();
  const { approvalId, summary } = refValue;

  const fetcher = useCallback(async (): Promise<ApprovalResolution | null> => {
    try {
      return await client.approvals.get(approvalId);
    } catch (reason) {
      // An approval the wire no longer knows is no longer actionable: the
      // TTL sweep (or a store erase) got there first. Same terminal state.
      if (reason instanceof VendoError && reason.code === "not-found") {
        return { state: "expired" };
      }
      throw reason;
    }
  }, [client, approvalId]);

  // Poll until the state is terminal; useResource disarms when pollMs clears.
  const [pollMs, setPollMs] = useState<number | undefined>(APPROVAL_POLL_MS);
  const { data, error, refresh } = useResource<ApprovalResolution | null>(
    fetcher,
    null,
    pollMs === undefined ? {} : { pollMs },
  );
  useEffect(() => {
    if (data !== null && data.state !== "pending") setPollMs(undefined);
  }, [data]);

  const decide = useCallback(
    async (decision: ApprovalDecision) => {
      await client.approvals.decide(approvalId, decision);
      await refresh();
    },
    [client, approvalId, refresh],
  );

  let body: ReactNode;
  if (data === null) {
    body = error !== undefined
      ? (
          <article className="fl-approval" aria-label={`Approval — ${summary}`}>
            <div className="fl-approval-title">{summary}</div>
            <div role="alert" className="fl-error">{error.message}</div>
          </article>
        )
      : <BeatLine state="working">{summary}</BeatLine>;
  } else if (data.state === "pending") {
    body = <ApprovalCard approval={data.request} onDecide={decide} />;
  } else if (data.state === "executed") {
    body = executedCard(summary, data.outcome);
  } else if (data.state === "declined") {
    body = <ResolvedApprovalCard summary={summary} ok={false} line="Declined — nothing ran" />;
  } else {
    body = <ResolvedApprovalCard summary={summary} ok={false} line="Expired — no longer waiting for approval" />;
  }

  return (
    <ChromeRoot>
      <div data-vendo-embed="approval">{body}</div>
    </ChromeRoot>
  );
}

/**
 * Inline generated app (`vendo/app-ref@1`): the build-beat bar while the
 * build streams, then the live app. In-app interactions go over the wire
 * (`apps.call`), never through the host's agent loop.
 */
export function VendoAppEmbed({ refValue }: VendoAppEmbedProps) {
  const { client, components } = useVendoContext();
  const { appId, title } = refValue;
  const [surface, setSurface] = useState<OpenSurface>();
  const [failed, setFailed] = useState<{ reason: string; retryable?: boolean }>();

  useEffect(() => {
    setSurface(undefined);
    setFailed(undefined);
    const startedAt = Date.now();
    let cancelled = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resolveFailed = (failure: { reason: string; retryable?: boolean }): void => {
      done = true;
      setFailed(failure);
    };
    const resolveSurface = (next: OpenSurface): void => {
      done = true;
      setSurface(next);
    };
    // 0.4.5 E2E cert (defect D) — the ABSOLUTE deadline. The poll below only
    // checks elapsed time when a wire request SETTLES, so a request that
    // hangs (or a wire that stops answering) used to leave the building beat
    // spinning past any deadline. This timer depends on nothing but the
    // clock: whatever the polls are doing, the beat resolves to the failed
    // vocabulary at the deadline.
    const deadlineTimer = setTimeout(() => {
      if (cancelled || done) return;
      resolveFailed({ reason: "the build never finished" });
    }, APP_BUILD_DEADLINE_MS);
    // Self-scheduling poll (useResource's pacing rule): the next attempt is
    // armed only after the current one settles. `vendo_create_app` returns
    // fast and the build streams server-side, so until there is an app to
    // serve the flagged poll answers a quiet `{kind:"pending"}` (a wire that
    // predates the flag still 404s — the catch arm keeps the same cadence, so
    // older servers only lose the quiet console). Keep asking until the app
    // lands, the build reports a terminal failure, or the deadline turns the
    // beat into the failed vocabulary.
    const attempt = async () => {
      try {
        const next = await withPollTimeout(client.apps.open(appId, { pending: true }), APP_OPEN_TIMEOUT_MS);
        if (cancelled || done) return;
        // A terminal build failure resolves the embed PROMPTLY with its
        // reason — the same in-place resolution a denied/expired approval
        // gets — never a wait for the client build deadline.
        if (next.kind === "failed") {
          resolveFailed({
            reason: next.reason,
            ...(next.retryable === undefined ? {} : { retryable: next.retryable }),
          });
          return;
        }
        if (next.kind !== "pending") {
          resolveSurface(next);
          return;
        }
        if (Date.now() - startedAt >= APP_BUILD_DEADLINE_MS) {
          resolveFailed({ reason: "the build never finished" });
          return;
        }
      } catch (reason) {
        if (cancelled || done) return;
        if (Date.now() - startedAt >= APP_BUILD_DEADLINE_MS) {
          resolveFailed({ reason: asError(reason).message });
          return;
        }
      }
      timer = setTimeout(() => void attempt(), APP_POLL_MS);
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, appId]);

  const building = surface === undefined && failed === undefined;
  return (
    <ChromeRoot>
      {/* The thread lane's app boundary: the bar narrates forming → live via
          the shared data-state contract ("building" | "ready"). */}
      <div className="fl-uihost fl-appcard" data-vendo-embed="app">
        <div className="fl-appcard-bar" data-state={building ? "building" : "ready"}>
          <span className="fl-appcard-dot" aria-hidden="true" />
          <span className="fl-boot-labels fl-appcard-name">
            <span className="fl-boot-building" aria-hidden={!building}>Building {title}…</span>
            <span className="fl-boot-ready" aria-hidden={building}>{title}</span>
          </span>
          <span className="fl-boot-hairline" aria-hidden="true" />
        </div>
        <div className="fl-appcard-body">
          {surface !== undefined ? (
            <AppFrame
              surface={surface}
              components={components}
              onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})}
            />
          ) : failed !== undefined ? (
            <>
              <BeatLine state="error">{title} — couldn't finish</BeatLine>
              <div className="fl-approval-more">{failed.reason}</div>
              {failed.retryable === true && (
                <div className="fl-approval-more">Retryable — ask for the app again to rebuild it.</div>
              )}
            </>
          ) : (
            <span className="fl-slot-skel" role="status" aria-label={`Building ${title}`}>
              <span className="fl-skel-line" style={{ width: "54%" }} />
              <span className="fl-skel-line" style={{ width: "78%" }} />
              <span className="fl-skel-line" style={{ width: "42%" }} />
            </span>
          )}
        </div>
      </div>
    </ChromeRoot>
  );
}

/**
 * The dispatcher: give it any `vendo_*` tool output and it renders the right
 * embed by `parseVendoToolEnvelope` — or nothing for plain data (the action
 * executed cleanly; the agent already consumed the result).
 */
export function VendoToolResult({ output }: VendoToolResultProps) {
  const envelope = parseVendoToolEnvelope(output);
  if (envelope === null) return null;
  return envelope.kind === VENDO_APP_REF_KIND
    ? <VendoAppEmbed refValue={envelope} />
    : <VendoApprovalEmbed refValue={envelope} />;
}
