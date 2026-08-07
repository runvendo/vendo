/**
 * The slice of `createApps`' closure that its namespace surfaces read.
 *
 * `AppsRuntime`'s nested namespaces (`access`, `inClient`, `review`, `pins`)
 * each live in their own module and are handed the pieces of the closure they
 * need — the same shape `interchange`/`history`/`review` already take, so a
 * namespace is readable beside its contract instead of two thousand lines away
 * from it. Every surface names its dependencies as a `Pick` of this one type,
 * which keeps a single description of what the closure offers.
 *
 * Internal — not exported from the package root.
 */
import type {
  AccessLevel,
  AppAccess,
  AppDocument,
  AppId,
  Json,
  RecordStore,
  RunContext,
  VendoRecord,
} from "@vendoai/core";
import type { AppHistoryAccess, PinIntentKind } from "./history.js";
import type { InClientApprovalAccess } from "./inclient.js";
import type { PlacementStore } from "./placements.js";
import type { ReviewLifecycle } from "./review.js";
import type { AppsConfig, AppsRuntime, EditResult, VersionEntry } from "./types.js";

export interface AppsRuntimeContext {
  config: AppsConfig;
  /** The `vendo_apps` collection every door reads and writes. */
  apps: RecordStore;
  /** Placement rows — "show this app in that slot" (placements.ts). */
  placementRows: PlacementStore;
  /** The capped version log and its pin-intent trail (history.ts). */
  history: AppHistoryAccess;
  /** The stored in-client approvals (inclient.ts). */
  inClientApprovals: InClientApprovalAccess;
  /** The review-kind remix lifecycle (review.ts). */
  review: ReviewLifecycle;
  /** Build contract §9.3 — the ONE permission check. */
  holds(
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel,
    known?: VendoRecord | null,
  ): Promise<boolean>;
  /** §9.4's posture: unviewable stays `not-found`, a denied viewer gets `forbidden`. */
  requireOwned(appId: AppId, ctx: RunContext, level?: AccessLevel): Promise<AppDocument>;
  /** Build contract §9.6 — the ONE Cloud gate on this block. */
  requireMultiParty(what: string): void;
  /** The app-access seam, or a loud refusal when the host wired none. */
  requireAccess(): AppAccess;
  /** Whether the host's `apps.review.reviewer` assertion covers this caller. */
  reviewerAsserted(ctx: RunContext): Promise<boolean>;
  /** The layer ladder, derived from the document (never a stored rung). */
  rungFor(app: AppDocument, declared?: VersionEntry["rung"]): VersionEntry["rung"];
  /** The ONE document write: version append, optimistic concurrency, row put. */
  persistEdit(
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
    options?: { armTrigger?: boolean; pinIntentKind?: PinIntentKind },
  ): Promise<AppDocument>;
  /** An edit result that persisted nothing, with the drift report attached. */
  failedEdit(
    app: AppDocument,
    instruction: string,
    issues: string[],
    retryable?: boolean,
  ): EditResult;
  /** ONE instruction through the ONE builder. */
  assembleEdit(
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<
    | { kind: "assembled"; app: AppDocument }
    | { kind: "escalate" }
    | { kind: "failed"; issues: string[] }
  >;
  /** An app-lifecycle audit event under an explicit subject. */
  reportGuard(
    principalSubject: string,
    appId: AppId,
    ctx: Pick<RunContext, "venue" | "presence" | "trigger" | "turnId">,
    detail: Record<string, Json>,
  ): Promise<void>;
  /** The `share` audit kind. */
  reportShare(appId: AppId, ctx: RunContext, detail: Record<string, Json>): Promise<void>;
  /** The `app-lifecycle` audit kind, under the calling principal. */
  reportLifecycle(
    operation: "create" | "delete" | "fork" | "promote" | "in-client-approve" | "pin-fork" | "pin-rebase" | "machine-provision" | "machine-destroy" | "place" | "unplace",
    appId: AppId,
    ctx: RunContext,
    extra?: Record<string, Json>,
  ): Promise<void>;
  /**
   * The finished runtime, as a thunk. A surface is constructed while the
   * `AppsRuntime` object literal is still forming, so the public doors one of
   * them re-enters (`pins.fork` runs an ordinary `edit`) resolve on call.
   */
  runtime(): AppsRuntime;
}
