/**
 * Structural declarations of wire-response shapes owned by sibling block
 * contracts (07-automations, 03-agent, 09-vendo §3).
 *
 * ui depends on core only (00-overview dependency rule), so shapes that the
 * wire returns but core does not export are declared here, verbatim from the
 * frozen contract text. "Cannot drift because both sides copied the same frozen
 * text" turned out to be a promise rather than a mechanism, so the shapes the
 * producer and this consumer BOTH speak are no longer restated here: they are
 * re-exported below from `core/src/app-surfaces.ts` and from the
 * app-generation contract door, `@vendoai/apps/contract`. The client's public
 * surface is unchanged, and this file no longer carries a second copy.
 *
 * That removes ui's copy; it does not by itself make one definition. The app
 * engine's server door still declares its own richer `EditResult`, so the name
 * has two declarations inside `@vendoai/apps` — see the note in
 * `apps/src/contract/wire-types.ts`.
 */
import {
  type ApprovalRequest,
  type AutomationId,
  type AutomationRecord,
  type IsoDateTime,
  type Membership,
  type PlacementEntry,
  type Principal,
  type ReviewStanding,
  type RunId,
  type ThreadId,
  type ToolOutcome,
  type TriggerSource,
} from "@vendoai/core";

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
  /** What the spot is for, as the host developer described it. Only an agent
   *  reads this; the picker shows the label. */
  description?: string;
  /** When a mounted slot last reported itself. */
  lastSeen: string;
}
import type { UIMessage } from "ai";

export type { PlacementEntry, ReviewStanding };

/** 06-apps §1/§8/§9 — the app-generation half of the wire. One definition,
 *  on the producer's browser-safe contract door. */
export type {
  AppListRow,
  EditResult,
  InClientVenue,
  OpenSurface,
  PendingSurface,
  SeedDrift,
  ShipDiff,
  VersionEntry,
} from "@vendoai/apps/contract";

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
  automationId: AutomationId;
  /** Who it ran as — the filter every owner-scoped view reads. */
  owner: Principal;
  /** Which runner ran it; absent for a steps task. */
  agent?: string;
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

/** 07-automations §1 — one entry of `GET /automations`: the record itself, an
 *  owned first-class thing with no app reference of any kind. `webhookSecret`
 *  is redacted by the server on every read. */
export type AutomationEntry = AutomationRecord;

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
  // The request is absent only for an in-app parked press read during the
  // resume window: still undecided, but the ask itself is gone (the umbrella's
  // ByoApprovalResolution says why). Surfaces keep waiting on it.
  | { state: "pending"; request?: ApprovalRequest }
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

/** What `POST /files` answers: where the file landed in the user's own files,
    and how big it was. The path is what the message then carries, so the
    transcript holds a reference and never the bytes. */
export interface UploadedFile {
  path: string;
  bytes: number;
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
