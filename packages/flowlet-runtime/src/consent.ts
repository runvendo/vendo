/**
 * `handleConsent` — the server-validated grant-creation endpoint logic
 * (ENG-193 §4.5). A host mounts this behind its own HTTP route; this
 * module is transport-agnostic — no `Request`/`Response` here, so it is
 * testable without a server and portable to any route layer. It has TWO
 * production mounts in this plan: `@flowlet/next`'s catch-all (Task 5, the
 * production path demo-bank runs) and the accounting demo's hand-rolled
 * route (Task 7) — see "Plan deviations" #1.
 *
 * Steps (mirrors the ruling): (a) load the thread's messages via the Store
 * seam, (b) find the approval-requested part with the given toolCallId and
 * confirm its tool name matches, (c) resolve the LIVE descriptor via the
 * caller-supplied resolver (each mount's static-toolset lookup, Tasks 5/6),
 * (d) call `createGrantManager.create` — which self-derives criticality and
 * throws on a critical tool; that throw becomes this function's 403, (e)
 * append a "consent" audit event regardless of outcome (the audit trail
 * records EVERY decision, not just the ones that minted a grant).
 */
import type { AuditLog, ConsentResponse, FlowletUIMessage, GrantStore, Principal, FadeShape } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import type { FadeTracker } from "./fade-tracker";
import { createGrantManager } from "./grant-manager";
import { dangerTier, isUnverified } from "./policy/tier";

export interface HandleConsentDeps {
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  /** Loads the thread's persisted messages (Task 3's onSettled writes them). */
  getMessages: (principal: Principal, threadId: string) => Promise<FlowletUIMessage[]>;
  /** ENG-193 §4.4 — optional (absent -> no fade tracking, the same graceful
   *  no-op every other optional seam in this codebase has). */
  fadeTracker?: FadeTracker;
  /** Review follow-up — optional (absent -> no dedup, the same graceful
   *  no-op every other optional seam here has): per-(principal, toolCallId)
   *  idempotency for this endpoint. A double-clicked "yes" (or any client
   *  retry) re-POSTs the SAME toolCallId; without this, each POST re-recorded
   *  a fade decision, appended another "consent" audit event, and — worse —
   *  tried to mint a SECOND grant. Construct ONE ledger alongside the other
   *  singleton deps (grants/audit/fadeTracker) at the mount's assembly site,
   *  not per-request, or it dedupes nothing. */
  seen?: ConsentLedger;
  now?: () => string;
}

/** Bounded so a long-lived process (or a demo that never restarts) can't grow
 *  this without limit — mirrors the FIFO-eviction shape `judgePolicy`'s memo
 *  and `breakers.ts`'s `countedEscalationIds` already use. */
const MAX_CONSENT_LEDGER = 1000;

export interface ConsentLedger {
  get(key: string): HandleConsentResult | undefined;
  set(key: string, result: HandleConsentResult): void;
}

/** A fresh in-memory idempotency ledger for `HandleConsentDeps.seen`. */
export function createConsentLedger(): ConsentLedger {
  const map = new Map<string, HandleConsentResult>();
  return {
    get: (key) => map.get(key),
    set: (key, result) => {
      if (map.size >= MAX_CONSENT_LEDGER) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, result);
    },
  };
}

export interface HandleConsentRequest {
  threadId: string;
  toolCallId: string;
  toolName: string;
  response: ConsentResponse;
}

export type HandleConsentResult =
  | { ok: true; fadeEligible?: { shape: FadeShape; proposalId: string; count: number } }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Structural view of the ai SDK tool-part shape this reads — matches
 *  `engine.ts`'s own `normalizeHistory` scanning, just keyed by toolCallId. */
interface ApprovalPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
}

function findApprovalPart(
  messages: FlowletUIMessage[],
  toolCallId: string,
): ApprovalPart | undefined {
  for (const message of messages) {
    for (const rawPart of message.parts) {
      const part = rawPart as ApprovalPart;
      if (
        part.type.startsWith("tool-") &&
        part.toolCallId === toolCallId &&
        (part.state === "approval-requested" || part.state === "approval-responded")
      ) {
        return part;
      }
    }
  }
  return undefined;
}

export async function handleConsent(
  deps: HandleConsentDeps,
  principal: Principal,
  req: HandleConsentRequest,
): Promise<HandleConsentResult> {
  const clock = deps.now ?? (() => new Date().toISOString());

  // Idempotency (review follow-up): a duplicate POST for the SAME toolCallId
  // (double-click, client retry) returns the cached result unchanged — no
  // second audit event, fade record, or grant. Scoped by principal too, same
  // as every other per-thread/per-call keying in this codebase.
  const ledgerKey = deps.seen ? `${principal.tenantId}::${principal.subject}::${req.toolCallId}` : undefined;
  if (ledgerKey !== undefined) {
    const cached = deps.seen!.get(ledgerKey);
    if (cached) return cached;
  }

  // Every decision — accepted OR rejected past body validation — leaves one
  // consent audit event (the module docstring's "records EVERY decision"
  // contract covers the rejected outcomes too).
  async function audited(result: HandleConsentResult): Promise<HandleConsentResult> {
    await deps.audit.append({
      at: clock(), principal, kind: "consent",
      consentId: req.response.id, decision: req.response.decision,
    });
    if (ledgerKey !== undefined) deps.seen!.set(ledgerKey, result);
    return result;
  }

  const messages = await deps.getMessages(principal, req.threadId);
  const part = findApprovalPart(messages, req.toolCallId);
  if (!part) {
    return audited({
      ok: false, status: 404,
      error: `no pending approval for toolCallId "${req.toolCallId}"`,
    });
  }
  const partToolName = part.type.slice("tool-".length);
  if (partToolName !== req.toolName) {
    return audited({
      ok: false, status: 400,
      error: `toolName "${req.toolName}" does not match the pending part's tool "${partToolName}"`,
    });
  }

  let fadeEligible: { shape: FadeShape; proposalId: string; count: number } | undefined;
  if (deps.fadeTracker) {
    const fadeDescriptor = deps.resolveDescriptor(req.toolName);
    // Fade eligibility is act-tier, verified-tool territory ONLY (ENG-193 §4.4
    // invariant — checked here structurally, not by convention: critical and
    // unverified tools never even reach `record`/`propose`).
    if (fadeDescriptor && dangerTier(fadeDescriptor) === "act" && !isUnverified(fadeDescriptor)) {
      const signal = req.response.decision === "no" ? "no" : "yes"; // "subset" reads as a yes
      deps.fadeTracker.record(principal, req.toolName, part.input, signal);
      if (signal === "yes") {
        const eligible = deps.fadeTracker.propose(principal, req.toolName, part.input);
        if (eligible) fadeEligible = eligible;
      }
    }
  }

  if (req.response.decision === "yes" && req.response.grant) {
    // Bind the grant to the consented tool SERVER-SIDE: `grant.tool` is
    // client-authored, and without this check a consent gesture shown for one
    // tool could mint a standing grant for a different one.
    if (req.response.grant.tool !== req.toolName) {
      return audited({
        ok: false, status: 400,
        error: `grant.tool "${req.response.grant.tool}" does not match the consented tool "${req.toolName}"`,
      });
    }
    const descriptor = deps.resolveDescriptor(req.toolName);
    if (!descriptor) {
      return audited({ ok: false, status: 404, error: `unknown tool "${req.toolName}"` });
    }
    const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });
    try {
      await manager.create(
        principal,
        {
          tool: req.response.grant.tool,
          scope: req.response.grant.scope,
          duration: req.response.grant.duration,
          // ENG-193 §4.3 review follow-up: session/task-duration grants MUST
          // carry a contextKey — grant-match.ts's non-standing check
          // (`grant.contextKey === undefined -> never matches`) fails closed
          // on one minted without it, so it was dead on arrival. Trace for
          // why `req.threadId` is the RIGHT id: this function already used
          // it two lines above this block to load the thread's messages
          // (`deps.getMessages(principal, req.threadId)`) — i.e. it's the
          // STORE thread id the client resolved for this very consent
          // request. On the production path (`@flowlet/next`'s
          // policy-stack.ts), `grantPolicy` is wired with
          // `contextKey: (ctx) => ctx.threadId`, and `ctx.threadId` is what
          // `engine.ts`'s `run()` resolves as `RunInput.threadId` (the
          // caller-supplied thread id, or the engine's own minted fallback)
          // for the SAME turn — the identical id the chat wiring threads
          // into `agent.run`. Minting with `contextKey: req.threadId`
          // therefore lines up exactly with what grantPolicy's contextKey
          // resolver looks up on the next call in this same thread.
          ...(req.response.grant.duration !== "standing" ? { contextKey: req.threadId } : {}),
          source: { kind: "chat" },
        },
        descriptor,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return audited({ ok: false, status: 403, error: message });
    }
  }

  return audited({ ok: true, ...(fadeEligible ? { fadeEligible } : {}) });
}
