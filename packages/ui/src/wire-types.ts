/**
 * Structural declarations of wire-response shapes owned by sibling block
 * contracts (06-apps, 07-automations, 03-agent, 09-vendo §3).
 *
 * ui depends on core only (00-overview dependency rule), so shapes that the
 * wire returns but core does not export are declared here, verbatim from the
 * frozen contract text. "Cannot drift because both sides copied the same frozen
 * text" turned out to be a promise rather than a mechanism, so the shapes the
 * producer and this consumer BOTH speak have moved to core
 * (`core/src/app-surfaces.ts`) and are re-exported below — the client's public
 * surface is unchanged, but there is now only one definition to drift from.
 */
import type {
  AppDocument,
  AppId,
  ApprovalRequest,
  IsoDateTime,
  Membership,
  PlacementEntry,
  ReviewStanding,
  RunId,
  ThreadId,
  Trigger,
  TriggerSource,
  ToolOutcome,
  UIPayload,
} from "@vendoai/core";
import type { UIMessage } from "ai";

export type { PlacementEntry, ReviewStanding };

/** 06-apps §1 — what `GET /apps/:id/open` returns. */
export type OpenSurface =
  | { kind: "tree"; payload: UIPayload; components?: Record<string, string> }
  | { kind: "http"; url: string }
  | { kind: "resuming"; cover?: string }
  /**
   * The build turn terminally FAILED (model error, quota, timeout): the app
   * will never become servable. The embed resolves promptly to the failed
   * vocabulary with this reason instead of polling to its build deadline.
   * `prompt` (when the failed record carries it) feeds the retry affordance —
   * re-issuing the exact create instead of the capped title.
   */
  | { kind: "failed"; reason: string; retryable?: boolean; prompt?: string };

/** Existing-agents polish — the flag-gated build-window answer: what
 *  `GET /apps/:id/open?pending=1` returns while the app is not yet servable
 *  (the record lands at build completion). Only flagged polls ever see it;
 *  unflagged callers keep the contracted not-found. */
export interface PendingSurface {
  kind: "pending";
}

/** One row of `GET /slots` — a destination a mounted `VendoSlot` reported on
 *  this deployment. A slot id is the HOST's markup, not a Vendo document, so
 *  nothing knows a slot exists until a slot says so; the registry is what
 *  carries that to a surface (the "Add to…" picker) on another page. Newest
 *  first, and already filtered to what the caller may place into. */
export interface SlotEntry {
  /** The slot's `id` — the value that goes over the wire as a placement. */
  id: string;
  /** What a person choosing a destination reads. */
  label: string;
  /** When a mounted slot last reported itself. */
  lastSeen: string;
}

/**
 * 06-apps §9 — the additive in-client venue verdict riding a tree payload
 * (`payload.inClient`). SERVER-AUTHORITATIVE: only the runtime's hash-pin
 * verification writes it. `granted: true` is the ONLY state that lets the
 * renderer mount generated code in the host page; a missing field and every
 * other state stay in the sandboxed iframe jail — except review-kind's
 * `reason: "pending-review"` (2026-08-02), which must render the ORIGINAL
 * host component: the server ships no executable fork source with it, so a
 * jailed fork render cannot occur. A granted verdict's `review` rider means
 * an OLDER approved version is being served while the current one awaits
 * review.
 */
export type InClientVenue =
  | { granted: true; versionHash: string; approvedBy: string; at: IsoDateTime; review?: ReviewStanding }
  | { granted: false; versionHash: string; reason: "version-changed" }
  | { granted: false; versionHash: string; reason: "pending-review"; review: ReviewStanding };

/**
 * 06-apps §8 — one drifted pin riding a tree payload (`payload.pinDrift`):
 * the host updated (or removed) the captured component this fork was remixed
 * from. SERVER-AUTHORITATIVE: only the runtime's baseline comparison writes
 * it. Informational — the renderer says so loudly but never mutates content;
 * a rebase is always user-invoked.
 */
export interface PinDrift {
  slot: string;
  component: string;
  baseHash: string;
  baselineHash?: string;
  reason: "baseline-changed" | "baseline-missing";
}

/** 06-apps §8–§9 — what `GET /apps/:id/ship-diff` returns. */
export interface ShipDiff {
  appId: AppId;
  versionHash: string;
  pins: Array<{
    slot: string;
    component: string;
    baseHash: string;
    baselineHash?: string;
    drifted: boolean;
    diff: string;
  }>;
  generated: Array<{ component: string; diff: string }>;
}

/** 06-apps §1 — what `POST /apps/:id/edit` returns. */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  issues?: string[];
  /** Additive 06 §8 drift report: present when the edited app has drifted pins. */
  driftedPins?: PinDrift[];
}

/**
 * 06-apps §8 — what `POST /apps/:id/rebase-pin` returns. `failed` persisted
 * NOTHING: the pre-rebase version stays live and the report lists which
 * recorded intents replayed, which one failed, and which were never attempted.
 */
export type PinRebaseResult =
  | {
    status: "rebased";
    app: AppDocument;
    version: VersionEntry;
    slot: string;
    baseHash: string;
    replayed: string[];
  }
  | {
    status: "failed";
    slot: string;
    baseHash: string;
    replayed: string[];
    failed: { intent: string; issues: string[] };
    remaining: string[];
  };

/**
 * 06-apps §8 — what `POST /apps/fork-pin` and `POST /apps/:id/fork-pin`
 * return: the gesture-owned DETERMINISTIC fork (engine copies the captured
 * baseline and records the pin; no model call). `version` describes the fork
 * itself; `edit` is present only when the gesture carried an instruction —
 * the ordinary edit that ran afterwards, already scoped to the forked
 * component. A failed `edit` never rolls the fork back, so `app` is always at
 * least the faithful fork.
 */
export interface PinForkResult {
  app: AppDocument;
  version: VersionEntry;
  slot: string;
  componentName: string;
  edit?: EditResult;
}

/** 06-apps §1 — one entry of `GET /apps/:id/history`. */
export interface VersionEntry {
  at: IsoDateTime;
  intent: string;
  rung: 1 | 2 | 3 | 4;
}

/** 04-actions §3 — one per-user connected account as `GET /connections` returns it. */
export interface ConnectionAccount {
  id: string;
  connector: string;
  toolkit: string;
  status: "initiated" | "active" | "expired" | "failed";
  createdAt?: IsoDateTime;
}

/** 04-actions §3 — what `POST /connections/initiate` returns. */
export interface InitiatedConnection {
  id: string;
  connector: string;
  redirectUrl: string;
}

/** One connectable toolkit as `GET /connections/catalog` advertises it — the
    connect dock's auto catalog when the host passes no explicit list. */
export interface ConnectableToolkit {
  toolkit: string;
  connector: string;
  label?: string;
  /** One-line capability blurb (provider metadata); surfaces may ignore it. */
  description?: string;
}

/** 07-automations §5. No waiting state: a run that meets a permission nobody
 *  granted fails LOUDLY (`error`, code `needs-permission`) and the person grants
 *  it and runs it again. */
export type RunStatus = "running" | "ok" | "error" | "stopped";

/** 07-automations §5 — what `/runs` routes return. */
export interface RunRecord {
  id: RunId;
  appId: AppId;
  /** WHICH trigger of the app fired this run. An app has a list of them, so the
   *  app id alone no longer says what ran. */
  triggerId: string;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;
  summary?: string;
  /** `needs-permission` is the code a surface acts on: `tool`/`slug` name what
   *  the run needed, so the row can offer Grant & re-run. */
  error?: { code: string; message: string; tool?: string; slug?: string };
}

/** 07-automations §1 — what `POST /automations/:id/dry-run` returns. */
export interface RunPlan {
  steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
  grantsMissing: string[];
}

/** 07-automations §1 — one entry of `GET /automations`. `pendingGrants` /
 *  `grantSetId` (additive) project the app's still-undecided standing-grant
 *  asks so panels can render "waiting on N permissions" reload-safely. */
export interface AutomationEntry {
  app: AppDocument;
  /** An automation is an app with a LIST of triggers, and everything a person
   *  decides is per trigger: armed, who it runs as, whether it stopped, what it
   *  is still waiting to be allowed. Only `editors` is per app. */
  triggers: AutomationTriggerEntry[];
  /** How many principals hold a grant on the app, when the deployment has an
   *  access seam at all — the wider editor set the label names. */
  editors?: number;
}

/** One trigger of an automation, as the panel renders it. */
export interface AutomationTriggerEntry {
  trigger: Trigger;
  enabled: boolean;
  pendingGrants?: number;
  grantSetId?: string;
  /** §13 — whose access it runs with. `display` only when the caller IS the
   *  sponsor: Vendo holds no directory, so a name for anyone else would be
   *  invented; the subject is the honest fallback. */
  sponsor?: { subject: string; display?: string };
  /** Set exactly while this trigger is STOPPED. `summary` is the same consumer
   *  sentence the stopped run row carries, so the list is a route back to a
   *  paused automation instead of the one place it vanished from. It never names
   *  the sponsor: anyone who can edit the app reads it. */
  stopped?: { reason: "edit" | "departure" | "grants"; summary: string };
}

/** 07-automations §1 — what `POST /automations/:id/enable` returns.
 *  `grantSetId` (additive) names the ONE set the `missing` asks belong to;
 *  present exactly when `missing` is non-empty. */
export interface EnableResult {
  enabled: boolean;
  missing: ApprovalRequest[];
  grantSetId?: string;
}

/** Existing-agents — what `GET /approvals/:id` returns for a parked BYO
 *  guarded call: the frozen `VendoApprovalEmbedState` vocabulary, carrying
 *  the full request while pending (the consent card shows real inputs) and
 *  the resumed call's outcome once executed (errors included — the embed
 *  renders them with the existing failed vocabulary, never a blank).
 *  Mirrors the umbrella's `ByoApprovalResolution`. */
export type ApprovalResolution =
  | { state: "pending"; request: ApprovalRequest }
  | { state: "executed"; outcome: ToolOutcome }
  | { state: "declined" }
  | { state: "expired" };

/** 03-agent §5 — what `GET /threads/:id` returns. */
export interface Thread {
  id: ThreadId;
  subject: string;
  messages: UIMessage[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 03-agent §5 — one entry of `GET /threads`. */
export interface ThreadSummary {
  id: ThreadId;
  title: string;
  updatedAt: IsoDateTime;
}

/** 05-guard §1 `status()` / 09-vendo §3 — what `GET /status` returns. */
export type GuardPosture = "unconfigured" | "rules" | "judge" | "rules+judge";

export interface VendoStatus {
  posture: GuardPosture;
  version: string;
  blocks: Record<string, unknown>;
  /** Build contract §9.1 — the orgs the host asserted for this caller this
      request. Absent on a single-player deployment; never stored anywhere. */
  memberships?: Membership[];
}
