/**
 * Escalation-reason side channel (ENG-193 §4.2/§4.5). `ApprovalPolicy.evaluate`
 * stays `Promise<ApprovalDecision>` — a plain three-value string, unchanged —
 * so a layer that needs to attach a PLAIN-LANGUAGE REASON to one particular
 * evaluation (the judge's escalation, a breaker tripping) stamps it here,
 * keyed by the exact `PolicyContext` OBJECT INSTANCE it was given, not by
 * tool name or any other structural key.
 *
 * This works because every composition layer in this codebase passes the
 * SAME ctx object through to inner/sibling policies rather than cloning it:
 * `composePolicy` calls `policy.evaluate(ctx)` for every sibling with the one
 * ctx it received; `grantPolicy`/`judgePolicy`/the breakers all call
 * `inner.evaluate(ctx)` the same way. `wrapTool`/`wrapClientTool` build ONE
 * ctx per call (in `needsApproval`, and a SEPARATE one in `execute` — a later,
 * different SDK turn) and read this map immediately after `evaluate`
 * resolves, before that ctx is discarded.
 *
 * A `WeakMap` means an evaluated ctx that's never re-read is garbage
 * collected normally — no manual cleanup, no unbounded growth, no leak.
 *
 * SOURCE TAG (review follow-up): a stamped reason also carries WHY it was
 * stamped — `"verdict"` (the judge model actually said "escalate", i.e. a
 * REAL judge escalation) or `"error"` (the judge's own escalate-ON-ERROR
 * bias — a model failure/unparseable output, not a verdict). The card and
 * audit trail read the REASON regardless of source (unchanged UX — an
 * error-path stop is still shown). `cautionBreaker` reads the SOURCE and
 * counts only `"verdict"` stamps toward tripping caution: model unreliability
 * must never manufacture caution mode on its own (breakers.ts's docstring:
 * caution counts "judge escalations", not judge failures). Callers that don't
 * care about the distinction (breakers' own forced-approve reasons) may omit
 * it — it defaults to `"verdict"`, which is harmless for them since none of
 * those call sites feed into `cautionBreaker`'s own counting check (that
 * check only ever inspects its immediate inner, which per the composition
 * contract is `judgePolicy` directly).
 */
import type { PolicyContext } from "./types.js";

export type EscalationSource = "verdict" | "error";

interface StampedEscalation {
  reason: string;
  source: EscalationSource;
}

const reasons = new WeakMap<PolicyContext, StampedEscalation>();

/** The judge's reason is MODEL-AUTHORED text bound for the card DOM, the
 *  data-consent part, and the audit trail — cap it at the single stamp site
 *  so every consumer gets the bounded, single-line form. */
const MAX_REASON_CHARS = 200;

/** Stamp a plain-language reason (and its {@link EscalationSource}) on this
 *  exact ctx instance. Whitespace (including newlines) collapses to single
 *  spaces and the result is capped at {@link MAX_REASON_CHARS} — see the
 *  constant's doc for why. */
export function setEscalationReason(
  ctx: PolicyContext,
  reason: string,
  source: EscalationSource = "verdict",
): void {
  reasons.set(ctx, { reason: reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS), source });
}

/** Read back a reason stamped on this exact ctx instance, if any. */
export function getEscalationReason(ctx: PolicyContext): string | undefined {
  return reasons.get(ctx)?.reason;
}

/** Read back the {@link EscalationSource} stamped on this exact ctx
 *  instance, if any — `undefined` when nothing was ever stamped. */
export function getEscalationSource(ctx: PolicyContext): EscalationSource | undefined {
  return reasons.get(ctx)?.source;
}
