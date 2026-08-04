/**
 * ONE pending-approvals poller per client (post-check H15).
 *
 * Every surface that shows the attention count reads the same asks: the
 * launcher badge, the waiting strip, the center's "Needs you" rail, the toast
 * feed. Each of those used to hold its OWN `useResource`, so a host mounting
 * both the overlay and the center ran three or four independent `GET /approvals`
 * intervals forever — 36 requests a minute with nothing waiting.
 *
 * This is the same shape as the run-activity store: a module singleton per
 * client, N subscribers, one request. The cadence is the FASTEST any subscriber
 * asked for (a surface that wants 5s still gets 5s), polling pauses while the
 * document is hidden, and the last unsubscribe stops it entirely.
 */
import type { ApprovalRequest } from "@vendoai/core";
import type { VendoClient } from "../client.js";

export interface ApprovalsSnapshot {
  data: ApprovalRequest[];
  error: Error | undefined;
  isLoading: boolean;
}

const NO_ASKS: ApprovalRequest[] = [];

/** Stable first-render / SSR snapshot (useSyncExternalStore compares identity). */
export const APPROVALS_LOADING: ApprovalsSnapshot = { data: NO_ASKS, error: undefined, isLoading: true };

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * A poll that returns the same asks must not re-render four surfaces.
 *
 * H-6 — "the same asks" meant the same IDS. An ask is not immutable: `risk` is
 * resolved per call (`resolveRisk`), so a re-graded ask keeps its "Read-only"
 * chip, its read-class sentence and its Details fold forever; and
 * `invalidatedGrant` — "this tool changed since you approved it" — is attached
 * later and never appeared at all. Both are the most consequential things a
 * card can say, and the poll that carried them was thrown away as a no-op.
 *
 * The whole ask is compared. A key-order difference would cost one extra
 * render, which is the safe direction; a missed CHANGE is the defect.
 */
function sameAsks(a: ApprovalRequest[], b: ApprovalRequest[]): boolean {
  return a.length === b.length && a.every((ask, index) => {
    const other = b[index];
    return other !== undefined && ask.id === other.id && JSON.stringify(ask) === JSON.stringify(other);
  });
}

function unchanged(a: ApprovalsSnapshot, b: ApprovalsSnapshot): boolean {
  return a.error === b.error
    && a.isLoading === b.isLoading
    && sameAsks(a.data, b.data);
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

class ApprovalsFeed {
  private snapshot = APPROVALS_LOADING;
  /** Subscriber → the cadence it asked for (0 = read-only, no polling). */
  private readonly cadences = new Map<() => void, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly list: () => Promise<ApprovalRequest[]>) {}

  read = (): ApprovalsSnapshot => this.snapshot;

  subscribe = (listener: () => void, pollMs: number): (() => void) => {
    const first = this.cadences.size === 0;
    this.cadences.set(listener, pollMs);
    if (first) {
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
      void this.refresh();
    } else {
      // A faster subscriber joined: re-arm on the new cadence.
      this.arm();
    }
    return () => {
      this.cadences.delete(listener);
      if (this.cadences.size > 0) {
        this.arm();
        return;
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
      this.stop();
      // Nobody is watching. Drop the in-flight response and the rows: the next
      // mount deserves its own first load, not a count that may be minutes old.
      this.generation += 1;
      this.snapshot = APPROVALS_LOADING;
    };
  };

  refresh = async (): Promise<void> => {
    const generation = (this.generation += 1);
    try {
      const data = await this.list();
      if (generation !== this.generation) return;
      this.publish({ data, error: undefined, isLoading: false });
    } catch (reason) {
      if (generation !== this.generation) return;
      this.publish({ ...this.snapshot, error: asError(reason), isLoading: false });
    } finally {
      // Self-scheduling, like useResource: the next poll is armed only once this
      // one settled, so a slow request can never stack overlapping fetches.
      if (generation === this.generation) this.arm();
    }
  };

  private publish(next: ApprovalsSnapshot): void {
    if (unchanged(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of [...this.cadences.keys()]) listener();
  }

  private arm(): void {
    this.stop();
    const cadence = this.cadence();
    if (cadence === undefined || hidden()) return;
    this.timer = setTimeout(() => void this.refresh(), cadence);
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The fastest cadence anybody asked for; undefined = nobody polls. */
  private cadence(): number | undefined {
    let fastest: number | undefined;
    for (const pollMs of this.cadences.values()) {
      if (pollMs > 0 && (fastest === undefined || pollMs < fastest)) fastest = pollMs;
    }
    return fastest;
  }

  private onVisibility = (): void => {
    // A background tab asks nothing. Coming back asks immediately, so the count
    // the user returns to is current rather than one cadence stale.
    if (hidden()) this.stop();
    else void this.refresh();
  };
}

const feeds = new WeakMap<VendoClient, ApprovalsFeed>();

export function approvalsFeed(client: VendoClient): ApprovalsFeed {
  let feed = feeds.get(client);
  if (feed === undefined) {
    feed = new ApprovalsFeed(() => client.approvals.pending());
    feeds.set(client, feed);
  }
  return feed;
}

export type { ApprovalsFeed };
