/** @vendoai/automations — automations that run while the user is away
 * (docs/contracts/07-automations.md).
 *
 * The package root exports exactly the 07 §1 public API.
 *
 * ZERO app concepts, and that is enforced rather than intended: this package
 * depends on `@vendoai/core` alone (`scripts/dependency-guard.mjs`). An
 * automation is a first-class principal-owned RECORD; a task reaches an app only
 * by naming one of its functions as an ordinary granted tool, which resolves
 * through the bound registry like anything else. Goal runs go to the named
 * runner map — this package never imports an agent.
 */
import type {
  ApprovalRequest,
  AutomationId,
  AutomationRecord,
  Guard,
  IsoDateTime,
  Json,
  Membership,
  Principal,
  RiskResolver,
  RunContext,
  RunId,
  StoreAdapter,
  StoreOps,
  ToolOutcome,
  ToolRegistry,
  TriggerSource,
} from "@vendoai/core";
import { createAutomationsEngine } from "./engine.js";

export { automationsInternals, type AutomationsInternals } from "./engine.js";
/** Standard-Webhooks verification, as plain functions. Exported because the
 *  umbrella's `POST /api/vendo/tick` door takes the SAME signature over the same
 *  scheme, and a second implementation of it is how the encoding drifts: the
 *  secret is base64url and must be decoded before the HMAC, which is exactly the
 *  bug that made every signed knock in a fleet answer 401. One implementation,
 *  reached across the package boundary the dependency guard allows. */
export { base64url, signedWebhookBytes, verifySignature } from "./webhook-signature.js";
export type { ReconcileAutomations } from "./create-surface.js";
export { UNATTENDED_IRREVERSIBILITY_RULE, unattendedIrreversibilityCheck } from "./law.js";

/** 07 §1 — createAutomations config. */
export interface AutomationsConfig {
  /** ALREADY guard-bound by the umbrella (05 §2). Every tool a task can reach —
   *  host tools, connectors, and an app's own functions — is in here. */
  tools: ToolRegistry;
  /** Core seam: run audit events + approval resumption (onApprovalDecision). */
  guard: Guard;
  store: StoreAdapter;
  /** The 42-op surface over that SAME store, when the composition could resolve
   *  one (`selectStoreOps` answers `undefined` for a store with neither its own
   *  ops nor a SQL handle). Every drawer this engine owns — automations, runs,
   *  grants, approvals, captures, the schedule cursors, the delivery ledger,
   *  sponsorship — is reached through `ops.engine.*`, so the allowlist gate
   *  applies to all of them. Unset, the same seven verbs are served straight off
   *  the adapter's own record doors (`engineOverAdapter`), which is what a host's
   *  BYO `StoreAdapter` gets. */
  ops?: StoreOps;
  /** The SAME per-call risk resolver the composition gave the guard. Arm-time
   *  capture grades a declared connector call with it, so the consent card states
   *  the grade the call will really run under and the grant it mints carries the
   *  descriptor hash the guard recomputes at fire time. Absent → every declared
   *  call is graded exactly as its descriptor says. */
  resolveRisk?: RiskResolver;
  /** Testability. */
  now?: () => Date;
  /** Max automations a single tick executes concurrently (default 4). A small
   *  pool keeps one tenant's fired runs from serializing behind another's while
   *  bounding fan-out. */
  tickConcurrency?: number;
  /** Per-run wall-clock budget (ms) the tick waits before moving on. This timeout
   *  does NOT cancel the run (only `runs.stop` aborts one) — it finishes and
   *  persists its terminal state in the background; the tick just stops blocking
   *  on it so a hung run cannot overrun the tick interval or starve other
   *  tenants. Absent → wait fully. */
  runTimeoutMs?: number;
  /** Build contract §9.1 — the SAME host org query the wire resolves per request,
   *  resolved here per fire. Keyed on Principal (never on a Request) precisely so
   *  an UNATTENDED run can call it with no session. Ridden onto the RunContext,
   *  never persisted; unset → no orgs asserted, so an org-owned record is
   *  reachable only by itself. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
}

/** 07 §5. There is no waiting state: a run that meets a permission it does not
 *  hold fails LOUDLY (`error`, code `needs-permission`) and the person grants it
 *  and re-runs. A run that could be resumed later was a run nobody could see the
 *  end of — it held an approval open, an identity open, and an intent open across
 *  an unbounded gap. */
export type RunStatus = "running" | "ok" | "error" | "stopped";

/** 07 §5 — ONE ledger. The owner / agent / automation / console views are
 *  FILTERS over it, never separate tables. */
export interface RunRecord {
  id: RunId;
  automationId: AutomationId;
  /** Who it ran as — the filter every owner-scoped view reads. */
  owner: Principal;
  /** Which runner ran it; absent for a steps task. */
  agent?: string;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  /** Goal runs: the report's toolCalls. Steps: one per call. */
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;
  /** Goal: model-written; steps: generated. */
  summary?: string;
  /** `code: "needs-permission"` is the one a surface acts on: the run met a
   *  permission nobody had granted, the ask is pending, and `tool`/`slug` name
   *  exactly what it needed — so the row can offer Grant & re-run instead of
   *  making the person go looking. */
  error?: { code: string; message: string; tool?: string; slug?: string };
}

/** 07 §5 */
export interface RunPlan {
  steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
  grantsMissing: string[];
}

/** 07 §1 — the PUBLIC surface, `vendo.automations`.
 *
 *  There is deliberately no `create` here. Authoring goes through the one
 *  internal create op (`automationsInternals`), which the four authoring doors
 *  call; a host that can observe and switch off automations must not be able to
 *  mint one. */
export interface AutomationsEngine {
  /** Deployment-wide, filtered. No `app` filter: this package has no app
   *  concepts — an app page filters by resolving its OWN `automations: string[]`
   *  and dropping the dead ids. */
  list(filter: { owner?: string; agent?: string }, ctx: RunContext): Promise<AutomationRecord[]>;
  get(id: AutomationId, ctx: RunContext): Promise<AutomationRecord | null>;
  /** The kill switch. `enable` runs grant capture; `missing` is what the owner
   *  still has to allow, and `grantSetId` names the ONE set so a single decision
   *  settles them all. `disable` stamps `disarmedBy: "user"`, which is what makes
   *  it survive every redeploy. */
  enable(
    id: AutomationId,
    ctx: RunContext,
  ): Promise<{ enabled: boolean; missing: ApprovalRequest[]; grantSetId?: string }>;
  disable(id: AutomationId, ctx: RunContext): Promise<void>;

  /** INVARIANT: idempotent. Due-ness comes from the engine's own schedule
   *  cursors, claimed atomically — there is no stored `next_fire_at`. A duplicate
   *  tick claims nothing and fires nothing. */
  tick(now?: Date): Promise<RunId[]>;
  /** Dev-only auto-timer around tick (long-lived hosts). */
  start(intervalMs?: number): () => void;
  /** Host product events — THE host seam (vendo.emit). Fires the emitter's own
   *  records and those of every org the memberships seam asserts for them. */
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  /** External events, mounted by the umbrella. Standard-webhooks verified per
   *  record against that record's own secret; deliveries deduped by
   *  (automation, delivery-id). */
  webhook(req: Request): Promise<Response>;

  runs: {
    get(id: RunId, ctx: RunContext): Promise<RunRecord | null>;
    list(
      filter: {
        automationId?: AutomationId;
        owner?: string;
        agent?: string;
        status?: RunStatus;
        cursor?: string;
      },
      ctx: RunContext,
    ): Promise<{ runs: RunRecord[]; cursor?: string }>;
    /** Kill switch: best-effort cancel, marks "stopped". */
    stop(id: RunId, ctx: RunContext): Promise<void>;
    /** A FRESH run of the same automation on the same event, against LIVE data:
     *  no replay, no restored mid-run state, nothing resumed. Refused when the
     *  automation is not armed. */
    rerun(id: RunId, ctx: RunContext): Promise<RunId>;
  };
  /** Preview: what it would run. Nothing executes. */
  dryRun(id: AutomationId, ctx: RunContext, event?: Json): Promise<RunPlan>;
}

/** 07 §1 — the engine. */
export function createAutomations(config: AutomationsConfig): AutomationsEngine {
  return createAutomationsEngine(config);
}
