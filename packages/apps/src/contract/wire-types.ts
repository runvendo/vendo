/**
 * The app-generation half of the wire — the shapes `/apps/*` returns.
 *
 * These were hand-copied into `@vendoai/ui` because "ui depends on core only"
 * and the producer lives in the server half. They live HERE now, on a door a
 * browser can import, so `@vendoai/ui` re-exports them instead of restating
 * them — one fewer copy, and ui's public surface is unchanged.
 *
 * NOT yet one definition. The server half declares its own richer `EditResult`
 * (`server/runtime/types.ts`) carrying `failure`, `graduated`, `box`,
 * `pendingEgress` and `automation`; this one is the four-field wire shape a
 * surface reads. Two declarations of the same name ship from this package, one
 * per door. Unifying them is a behavior question — which fields the wire is
 * allowed to expose — not a move, so it is deliberately left to the slice that
 * owns unifications rather than smuggled into a reorganization.
 *
 * The chat / connections / automations / status shapes stay in `@vendoai/ui` —
 * they are not app-generation vocabulary and have no producer here.
 */
import type { SeedDrift } from "./seed.js";
import {
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type ReviewStanding,
  type UIPayload,
} from "@vendoai/core";

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
 *  (no record yet, or a record the build is still writing — see
 *  `AppDocument.building`). Only flagged polls ever see it; unflagged callers
 *  keep the contracted not-found. */
export interface PendingSurface {
  kind: "pending";
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
  /** Additive 06 §8 drift report: present when the host component this app was
   *  seeded from has moved on. A warning — acting on it is the person's call. */
  seedDrift?: SeedDrift;
}


/** 06-apps §1 — one entry of `GET /apps/:id/history`. */
export interface VersionEntry {
  at: IsoDateTime;
  intent: string;
  rung: 1 | 2 | 3 | 4;
}
