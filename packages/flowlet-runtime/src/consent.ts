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
 *
 * A plain "yes" with no client-authored grant draft is NOT a no-op (spec
 * §4.3): the server mints a session-scoped exact grant itself — "allow once"
 * — so a byte-identical repeat call in the same thread doesn't re-ask. An
 * explicit client draft still takes precedence over this implicit mint, and
 * critical tools never get one, checked before ever calling the manager.
 */
import type { AuditLog, ConsentResponse, FlowletUIMessage, GrantStore, Principal, FadeShape } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import type { FadeTracker } from "./fade-tracker";
import { createGrantManager } from "./grant-manager";
import { hashInput } from "./policy/grant-match";
import { dangerTier, isUnverified } from "./policy/tier";

/** Cap for the server-derived "allow once" grant's Trust-screen preview text
 *  (ENG-193 spec §4.3's `inputPreview` field) — mirrors `scopePreview`'s own
 *  short-and-readable intent (grant-manager.ts) without needing a full
 *  field-flattening pass for what's already small approval-card input. */
const ALLOW_ONCE_PREVIEW_CAP = 120;

function previewInput(input: unknown): string {
  const text = JSON.stringify(input) ?? "null";
  return text.length <= ALLOW_ONCE_PREVIEW_CAP ? text : `${text.slice(0, ALLOW_ONCE_PREVIEW_CAP)}…`;
}

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
  /** Test seam only — overrides the real `setTimeout`-based wait the retry
   *  below uses between lookups. Production never sets this. */
  sleep?: (ms: number) => Promise<void>;
}

/** Bounded so a long-lived process (or a demo that never restarts) can't grow
 *  this without limit — mirrors the FIFO-eviction shape `judgePolicy`'s memo
 *  and `breakers.ts`'s `countedEscalationIds` already use. */
const MAX_CONSENT_LEDGER = 1000;

/**
 * ENG-193 PR #40 review (documented v1 gap, item F) — `engine.ts`'s
 * `onSettled` persists the run's messages fire-and-forget AFTER the stream
 * response has already gone out; a client that sees the streamed
 * approval-requested part and POSTs consent immediately can race that write.
 * Without changing the persistence architecture, a couple of short retries on
 * a miss closes most of the real window cheaply: 2 retries, 250ms apart (3
 * lookups total) before giving up and 404ing.
 */
const APPROVAL_LOOKUP_RETRIES = 2;
const APPROVAL_LOOKUP_RETRY_DELAY_MS = 250;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 *  `engine.ts`'s own `normalizeHistory` scanning, just keyed by toolCallId.
 *  `approval` mirrors `engine.ts`'s `ClientResultPart.approval` (ai@6.0.28's
 *  `UIToolInvocation` shape): present ONLY when the call actually went
 *  through the SDK's native approval round-trip — a call the SDK
 *  auto-allowed carries no `approval` field at all, on ANY state, terminal
 *  or not. That's the exact fact this file's evidence check below relies on. */
interface ApprovalPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
}

/**
 * Finding 5 (as fixed post-Greptile-P1): match on toolCallId, but ONLY on a
 * part that carries APPROVAL EVIDENCE — never a bare state match. Two shapes
 * qualify: (1) `approval-requested`/`approval-responded` — the card is either
 * pending or was just answered; (2) a TERMINAL state (`output-available`,
 * `output-denied`, `output-error`) whose part STILL carries its `approval`
 * field — the SDK stamps that field on a part only when it went through the
 * native approval round-trip (`engine.ts`'s `ClientResultPart` doc), and it
 * survives the state transition to terminal (that's what let Finding 5's
 * original fast-approval race — the shell resuming the SDK approval before
 * this POST's `getMessages` read observes the persisted terminal state —
 * still validate). A terminal part with NO `approval` field was AUTO-ALLOWED
 * (no card ever shown, no human in the loop) and must NOT anchor a grant of
 * any kind: Greptile P1 — the original "ANY state" relaxation dropped this
 * distinction entirely, so an ordinary auto-allowed execution could satisfy a
 * same-origin consent POST for its toolCallId and mint a standing (explicit
 * draft) or implicit session-exact grant with no approval ever having been
 * presented, violating the server-validation contract that every grant
 * traces to an approval the user actually saw. KNOCK-ON (replay): this does
 * NOT reopen a replay concern — `handleConsent`'s idempotency ledger
 * (`deps.seen`) caches ONLY `ok: true` outcomes and short-circuits BEFORE
 * this lookup even runs (see the ledger check above), so a repeated POST for
 * a toolCallId that already succeeded once returns the cached result and
 * never re-reaches `findApprovalPart` at all — this evidence check doesn't
 * change that dedupe.
 */
function findApprovalPart(
  messages: FlowletUIMessage[],
  toolCallId: string,
): ApprovalPart | undefined {
  for (const message of messages) {
    for (const rawPart of message.parts) {
      const part = rawPart as ApprovalPart;
      if (part.type.startsWith("tool-") && part.toolCallId === toolCallId && hasApprovalEvidence(part)) {
        return part;
      }
    }
  }
  return undefined;
}

const TERMINAL_STATES = new Set(["output-available", "output-denied", "output-error"]);

function hasApprovalEvidence(part: ApprovalPart): boolean {
  if (part.state === "approval-requested" || part.state === "approval-responded") return true;
  return part.state !== undefined && TERMINAL_STATES.has(part.state) && part.approval !== undefined;
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
  //
  // Review follow-up: the ledger caches ONLY `ok: true` outcomes. A `404`
  // ("no pending approval") is frequently the TRANSIENT onSettled-persistence
  // race (see APPROVAL_LOOKUP_RETRIES above) rather than a real permanent
  // miss — caching it would pin a retry-worthy failure forever, so a client
  // retry after the part finally lands would keep getting the stale 404
  // instead of succeeding. Every failure (400/403/404) therefore always
  // re-evaluates from scratch; only a genuine success is idempotent.
  async function audited(result: HandleConsentResult): Promise<HandleConsentResult> {
    await deps.audit.append({
      at: clock(), principal, kind: "consent",
      consentId: req.response.id, decision: req.response.decision,
    });
    if (ledgerKey !== undefined && result.ok) deps.seen!.set(ledgerKey, result);
    return result;
  }

  // Retry the lookup on a miss (ENG-193 PR #40 review — item F): the
  // engine's onSettled persistence is fire-and-forget and can still be in
  // flight when this POST arrives. `sleep` between attempts is a test seam
  // only (default: a real setTimeout wait).
  const sleep = deps.sleep ?? realSleep;
  let messages = await deps.getMessages(principal, req.threadId);
  let part = findApprovalPart(messages, req.toolCallId);
  for (let attempt = 0; !part && attempt < APPROVAL_LOOKUP_RETRIES; attempt++) {
    await sleep(APPROVAL_LOOKUP_RETRY_DELAY_MS);
    messages = await deps.getMessages(principal, req.threadId);
    part = findApprovalPart(messages, req.toolCallId);
  }
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
  } else if (req.response.decision === "yes" || req.response.decision === "subset") {
    // Greptile P1 (spec §4.3: "'Allow once' = a session-scoped exact grant"):
    // a plain "yes" with NO client-authored grant draft used to mint
    // nothing, so a byte-identical repeat call in the SAME conversation
    // re-asked — the retired `rememberDecisions` ask-once behavior never
    // actually survived. The server now mints the session-scoped exact grant
    // itself, from the SAME approval part this function already resolved
    // (`part.input`), so a repeat of the identical call is suppressed by
    // `grantPolicy` for the rest of this thread while anything else still
    // asks.
    //
    // Review follow-up: "subset" (a batch approval's per-call POST for an
    // ACCEPTED item, consentResponseSchema's third decision value) is
    // affirmative here too — it is not a distinct outcome, just how a batch
    // card's accepted items are individually confirmed (each POST still
    // resolves exactly one toolCallId, ENG-193 §4.5). Before this fix only
    // "yes" minted the implicit grant, so a byte-identical repeat of a
    // SUBSET-approved call re-asked even though the user had just approved
    // it. Same path, same critical-tier skip below — a batch never mints for
    // a critical tool either.
    //
    // Critical is skipped CLEANLY here — never by relying on
    // `grantManager.create`'s own throw, which is a refusal for the EXPLICIT-
    // draft path above, not a mechanism this implicit path should lean on.
    // Unverified tools are NOT excluded (Yousef ruling, ENG-193 §4.1): an
    // exact-scope session grant only suppresses a byte-identical repeat, so
    // it's safe regardless of the unverified flag.
    const descriptor = deps.resolveDescriptor(req.toolName);
    if (descriptor && dangerTier(descriptor) !== "critical") {
      const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });
      await manager.create(
        principal,
        {
          tool: req.toolName,
          scope: { kind: "exact", inputHash: hashInput(part.input), inputPreview: previewInput(part.input) },
          duration: "session",
          // Same store-thread-id reasoning as the explicit-draft path above —
          // req.threadId is the id grantPolicy's contextKey resolver looks up
          // on the next call in this same thread.
          contextKey: req.threadId,
          source: { kind: "chat" },
        },
        descriptor,
      );
    }
  }

  // Finding 6: fadeTracker.record/propose moved HERE — after every rejecting
  // validation above has passed — so a request that's about to 400/403/404
  // (grant.tool mismatch, unknown tool, a refused critical/duplicate grant)
  // never records a decision first. Previously this ran BEFORE the
  // grant.tool mismatch check, so a retried bad POST accumulated a "yes" on
  // every attempt despite never succeeding. Reaching this point means either
  // there was no grant to validate (a plain "yes"/"no", or "yes" with no
  // grant) or the grant validations above all passed — the success path,
  // exactly what fade tracking is meant to observe.
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

  return audited({ ok: true, ...(fadeEligible ? { fadeEligible } : {}) });
}
