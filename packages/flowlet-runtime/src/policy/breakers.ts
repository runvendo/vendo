/**
 * Deterministic seatbelts (ENG-193 §4.7) — no LLM, always on, compose
 * OUTSIDE `judgePolicy`: they see whatever it decided and can only tighten
 * further (most-restrictive-wins), never loosen. State is in-memory, keyed
 * by `principal.userId :: threadId` (a shared/guessable threadId under a
 * different user must never read or trip another user's breaker state;
 * module-scope store injected — the same pattern the retired
 * `rememberDecisions`/`DecisionStore` used); swap for cloud persistence later
 * behind the same `BreakerState` shape.
 *
 * NESTING ORDER IS LOAD-BEARING. `cautionBreaker` must wrap `judgePolicy`'s
 * output DIRECTLY:
 *
 *     volumeBreaker(cautionBreaker(judgePolicy(grantPolicy(base, ...), opts)), state)
 *
 * `cautionBreaker` counts JUDGE escalations specifically (spec §4.7: "counts
 * judge escalations per thread"). It tells a judge escalation apart from
 * anything else by checking whether its OWN `inner.evaluate(ctx)` returned
 * "approve" with a reason already stamped on `ctx` — if `volumeBreaker` sat
 * BETWEEN `cautionBreaker` and `judgePolicy`, a volume-forced "unusual
 * volume" approval would look identical to a judge escalation and get
 * miscounted. Putting `volumeBreaker` OUTSIDE `cautionBreaker` instead keeps
 * `cautionBreaker`'s immediate inner as `judgePolicy`, and only it, so the
 * attribution is unambiguous. Review follow-up: a stamped reason ALSO needs
 * its source to be `"verdict"` (a real judge escalation), not `"error"`
 * (judge-policy's own escalate-on-error bias) — see escalation.ts's
 * docstring; a flaky/unparseable judge model must never manufacture caution
 * mode on its own.
 *
 * Both breakers skip entirely when `ctx.threadId` is undefined — an
 * automation context, item 4's territory (see judge-policy.ts's docstring
 * for the same reasoning: no per-run isolation exists here yet for
 * unattended firings).
 *
 * Caution is scoped to the ACT tier only: reads keep flowing even in
 * caution mode (Moment 1's promise has no exception), and critical's
 * ceremony is unconditional either way — caution can tighten nothing there
 * because nothing is ever loosened for critical in the first place. Review
 * follow-up: an active caution also never forces a source-"control" (control-
 * plane) act-tier call — the user's own "always ask before"/"stop asking
 * about" utterances only ever ADD safety, so gating them behind a caution
 * card would be counterproductive. A host-supplied server tool (source
 * "engine") is NOT exempt here — ENG-193 PR #40 review (item A): only
 * Flowlet's own control-plane tools (render_view/request_connect, steering,
 * automation authoring) carry source "control"; a mount's own business tools
 * must never ride that exemption.
 *
 * `volumeBreaker` carries the SAME two exemptions (review follow-up — it
 * previously had neither): a read-tier or source-"control" call is never
 * forced to approve on volume, and — since "reads just flow" has no exception
 * and a control-plane call is the user's own literal instruction, not agent
 * behavior to rate-limit — is never even COUNTED toward the threshold either.
 * Without this, 15 reads or `render_view` calls in one thread forced an
 * approval card, breaking Moment 1's promise.
 */
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import { dangerTier } from "./tier";
import { getEscalationReason, getEscalationSource, setEscalationReason } from "./escalation";

export interface BreakerState {
  /** Executed-call counts per principal::thread per tool (fed by onExecuted). */
  volumeCounts: Map<string, Map<string, number>>;
  /** Per-principal::thread caution tracking. */
  caution: Map<string, CautionRecord>;
}

interface CautionRecord {
  active: boolean;
  consecutiveEscalations: number;
  totalEscalations: number;
  cleanApprovals: number;
  /**
   * toolCallIds whose escalation was already counted (bounded FIFO). The SDK
   * evaluates the composed policy TWICE per call — needsApproval AND execute
   * — with the SAME toolCallId; without this, one escalated call counted
   * twice and caution tripped at ~half the documented thresholds, dependent
   * on whether the user approved (whether execute's evaluation ever ran).
   */
  countedEscalationIds: string[];
}

/** Bound on the per-thread counted-escalation FIFO — plenty for the SDK's
 *  two-evaluations-per-call window, tiny enough to never matter. */
const MAX_COUNTED_IDS = 64;

export function createBreakerState(): BreakerState {
  return { volumeCounts: new Map(), caution: new Map() };
}

/** Breaker state key: principal + thread (undefined = automation context).
 *  A different user on the SAME threadId gets fully independent state. */
function threadKey(ctx: PolicyContext): string | undefined {
  if (ctx.threadId === undefined) return undefined;
  return `${ctx.principal.userId}::${ctx.threadId}`;
}

// ---------------------------------------------------------------------------
// volumeBreaker
// ---------------------------------------------------------------------------

export interface VolumeBreakerOptions {
  /** Executed calls of ONE tool in ONE thread before this forces a card. Default 15. */
  threshold?: number;
}

export function volumeBreaker(
  inner: ApprovalPolicy,
  state: BreakerState,
  opts: VolumeBreakerOptions = {},
): ApprovalPolicy {
  const threshold = opts.threshold ?? 15;

  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      const decision = await inner.evaluate(ctx);
      if (decision === "deny") return decision;
      if (dangerTier(ctx.descriptor) === "critical") return decision;
      // Same two exemptions cautionBreaker has (review follow-up, see this
      // module's docstring): reads never get a forced card, and a
      // control-plane (source "control") call is the user's own instruction,
      // not agent volume to rate-limit. A host-supplied "engine"-source tool
      // is NOT exempt (ENG-193 PR #40 review — item A).
      if (dangerTier(ctx.descriptor) === "read") return decision;
      if (ctx.descriptor.source === "control") return decision;
      const key = threadKey(ctx);
      if (key === undefined) return decision; // automation context — item 4
      if (decision !== "allow") return decision; // nothing to force — already asking
      const count = state.volumeCounts.get(key)?.get(ctx.toolName) ?? 0;
      if (count >= threshold) {
        setEscalationReason(ctx, "unusual volume");
        return "approve";
      }
      return decision;
    },
    async onExecuted(ctx, decision) {
      await inner.onExecuted?.(ctx, decision);
      // Don't even COUNT a read or source-"control" execute toward the
      // threshold (review follow-up) — symmetric with the exemption above.
      if (dangerTier(ctx.descriptor) === "read") return;
      if (ctx.descriptor.source === "control") return;
      const key = threadKey(ctx);
      if (key === undefined) return;
      let perTool = state.volumeCounts.get(key);
      if (!perTool) {
        perTool = new Map();
        state.volumeCounts.set(key, perTool);
      }
      perTool.set(ctx.toolName, (perTool.get(ctx.toolName) ?? 0) + 1);
    },
  };
}

// ---------------------------------------------------------------------------
// cautionBreaker
// ---------------------------------------------------------------------------

export interface CautionBreakerOptions {
  /** Consecutive judge escalations that trip caution. Default 3. */
  consecutiveThreshold?: number;
  /** Total (non-consecutive) judge escalations that trip caution. Default 8. */
  totalThreshold?: number;
  /** Clean (non-flagged) human approvals that lift caution. Default 5. */
  cleanApprovalsToLift?: number;
}

function cautionFor(state: BreakerState, key: string): CautionRecord {
  let rec = state.caution.get(key);
  if (!rec) {
    rec = { active: false, consecutiveEscalations: 0, totalEscalations: 0, cleanApprovals: 0, countedEscalationIds: [] };
    state.caution.set(key, rec);
  }
  return rec;
}

/** True when this toolCallId's escalation was already counted; records it
 *  otherwise. An id-less ctx (bare unit tests) is never deduped — production
 *  contexts always carry a toolCallId (`wrapTool`/`wrapClientTool`). */
function alreadyCounted(rec: CautionRecord, toolCallId: string | undefined): boolean {
  if (toolCallId === undefined) return false;
  if (rec.countedEscalationIds.includes(toolCallId)) return true;
  rec.countedEscalationIds.push(toolCallId);
  if (rec.countedEscalationIds.length > MAX_COUNTED_IDS) rec.countedEscalationIds.shift();
  return false;
}

export function cautionBreaker(
  inner: ApprovalPolicy,
  state: BreakerState,
  opts: CautionBreakerOptions = {},
): ApprovalPolicy {
  const consecutiveThreshold = opts.consecutiveThreshold ?? 3;
  const totalThreshold = opts.totalThreshold ?? 8;
  const cleanApprovalsToLift = opts.cleanApprovalsToLift ?? 5;

  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      const decision = await inner.evaluate(ctx);
      if (decision === "deny") return decision;
      if (dangerTier(ctx.descriptor) === "critical") return decision;
      const key = threadKey(ctx);
      if (key === undefined) return decision; // automation context — item 4
      const rec = cautionFor(state, key);

      // inner is judgePolicy DIRECTLY (composition contract, see docstring):
      // an "approve" with a reason already stamped IS a judge escalation —
      // but ONLY when that reason's source is "verdict" (the judge model
      // actually said "escalate"). A source of "error" is judge-policy's own
      // escalate-on-error bias (a model failure/unparseable output) — review
      // follow-up: model unreliability must never manufacture caution mode
      // on its own (see escalation.ts's docstring). Counted at most ONCE per
      // toolCallId — the SDK evaluates the same call twice (needsApproval +
      // execute), see CautionRecord's doc.
      if (
        decision === "approve" &&
        getEscalationSource(ctx) === "verdict" &&
        !alreadyCounted(rec, ctx.toolCallId)
      ) {
        rec.consecutiveEscalations += 1;
        rec.totalEscalations += 1;
        rec.cleanApprovals = 0;
        if (rec.consecutiveEscalations >= consecutiveThreshold || rec.totalEscalations >= totalThreshold) {
          rec.active = true;
        }
      }

      // Review follow-up: an active caution must never block the user's OWN
      // "always ask me"/"stop asking about" command (source "control", act
      // tier) — tightening tools only ever ADD safety, so gating them behind
      // a caution card is counterproductive, not protective. A host-supplied
      // "engine"-source tool IS still gated by caution (ENG-193 PR #40
      // review — item A).
      if (
        dangerTier(ctx.descriptor) === "act" &&
        rec.active &&
        decision === "allow" &&
        ctx.descriptor.source !== "control"
      ) {
        setEscalationReason(ctx, "a few things seemed unusual, so I'm checking with you for a bit");
        return "approve";
      }
      return decision;
    },
    async onExecuted(ctx, decision) {
      await inner.onExecuted?.(ctx, decision);
      if (dangerTier(ctx.descriptor) === "critical") return;
      const key = threadKey(ctx);
      if (key === undefined) return;
      const rec = cautionFor(state, key);
      if (!rec.active) return;
      // A CLEAN human approval — this exact call was NOT flagged — counts
      // toward lifting caution. An approval the user granted despite a
      // flag does not (they said yes to something suspicious, not "all clear").
      if (decision === "approve" && getEscalationReason(ctx) === undefined) {
        rec.cleanApprovals += 1;
        rec.consecutiveEscalations = 0;
        if (rec.cleanApprovals >= cleanApprovalsToLift) {
          rec.active = false;
          rec.totalEscalations = 0;
          rec.cleanApprovals = 0;
        }
      }
    },
  };
}
