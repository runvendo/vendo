/**
 * The apps runtime's ANSWER shapes that the client must speak too.
 *
 * Membership rule, and the only one: a shape belongs here when `@vendoai/apps`
 * produces it and `@vendoai/ui` consumes it off the wire. `ui → apps` is not an
 * edge the dependency guard allows, so before this the client hand-declared its
 * own copy "verbatim from the frozen contract text" — which is a promise, not a
 * mechanism, and the copies drifted. Same split, same reason, as
 * {@link ./app-access.js}: the shape lives in core, the implementation stays in
 * the block that owns the behavior.
 *
 * Only the shapes BOTH sides speak move here. An apps-internal shape (the
 * placement STORAGE row, say) stays in apps.
 */
import type { AppId, IsoDateTime } from "./ids.js";

/**
 * One slot's answer — what is in it, and where that app's build stands. `status`
 * is derived from the app record on every read, never stored, so a build that
 * lands (or fails) needs no second write to correct the slot.
 */
export interface PlacementEntry {
  slot: string;
  app: AppId;
  /** The app's name, or "" while the build has not landed (there is no
   *  document yet to take a title from). */
  title: string;
  status: "ready" | "building" | "failed";
}

/**
 * Remix final shape (2026-08-02) — where the CURRENT version of a review-kind
 * app stands with the host reviewer, riding the in-client venue state so the
 * user's panel can say "sent for review" or surface the rejection note.
 * Server-authoritative, like the rest of the venue field.
 */
export type ReviewStanding =
  | { status: "pending"; versionHash: string }
  | { status: "rejected"; versionHash: string; note: string; by: string; at: IsoDateTime };
