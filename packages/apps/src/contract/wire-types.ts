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
  type IsoDateTime,
  type UIPayload,
} from "@vendoai/core";

/** One row of `GET /apps` — the document, plus what only THIS caller's read can
 *  say about it. `unseen` is derived per caller and never stored on the row
 *  every reader shares: set while the app has never rendered for them, absent
 *  once it has (`persistence/app-seen.ts`). */
export interface AppListRow extends AppDocument {
  unseen?: boolean;
}

/** 06-apps §1 — what `GET /apps/:id/open` returns. */
export type OpenSurface =
  | { kind: "tree"; payload: UIPayload; components?: Record<string, string> }
  | { kind: "http"; url: string }
  /** A SEALED bundle. `entry` is the content hash of the file the frame boots,
   *  so it is both the address to fetch (`GET /apps/:id/bundle/:hash`) and the
   *  frame's remount key. */
  | { kind: "bundle"; entry: string }
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
  /**
   * What the build last said about itself (`AppDocument.buildStatus`) — one
   * line, replaced each time, and the WHOLE of the progress channel FINAL SPEC
   * v1 allows: no stream, no subscription, nothing held open. Absent until the
   * lane speaks, and absent for a build that never does, in which case the
   * embed keeps the label it already had.
   */
  status?: string;
  /**
   * The app's tree AS IT FORMS, so the embed's existing poll paints stepped
   * assembly instead of a blind bar. GEOMETRY ONLY — node ids, component names
   * and nesting, tagged `streaming` — because a build's draft carries figures it
   * is about to correct (`build-terminal-mount.e2e.test.ts`: a double count the
   * repair round replaces), and nobody may be shown a number the build is about
   * to change. Nothing that could render one travels: no props, no resolved
   * `data`, no `interactive` VM, no component sources.
   *
   * Read out of memory, never rendered for the answer: a poll must cost a row
   * read, not an app execution. It is the shape of the last screen the BUILD
   * itself painted (`persistence/forming.ts`), so it rides once this app has
   * painted in this process and is absent otherwise — nothing about it is
   * persisted, because no document keeps a tree.
   *
   * Optional and additive throughout: whenever it is absent the embed keeps its
   * beat bar, which is exactly the behaviour that shipped before it existed.
   */
  tree?: UIPayload;
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
