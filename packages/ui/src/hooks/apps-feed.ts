/**
 * ONE apps poller per client.
 *
 * The same shape as `approvals-feed.ts`, and for the same reason: the app
 * collection has more than one reader — every `useApps` caller, and the launcher
 * pill, which needs the unseen count to light its dot. A module store fed by
 * whichever of them happened to mount cannot do that: the count froze at the
 * moment of mount, so an app that arrived mid-session never lit the dot,
 * rendering one never cleared it, and a host whose surfaces never list apps read
 * zero forever.
 *
 * One request between them, at the FASTEST cadence any subscriber asked for.
 * `unseen` rides the rows that fetch already returns, so the dot costs no
 * request of its own — there is no second poller to keep in step with this one.
 */
import type { VendoClient } from "../client.js";
import type { AppListRow } from "../wire-types.js";

export interface AppsSnapshot {
  data: AppListRow[];
  error: Error | undefined;
  isLoading: boolean;
}

const NO_APPS: AppListRow[] = [];

/** Stable first-render / SSR snapshot (useSyncExternalStore compares identity). */
export const APPS_LOADING: AppsSnapshot = { data: NO_APPS, error: undefined, isLoading: true };

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** Whole-row comparison, like the asks feed: `unseen` flips on a row whose id
 *  and name never change, and that flip IS the dot. */
function sameApps(a: AppListRow[], b: AppListRow[]): boolean {
  return a.length === b.length && a.every((app, index) => {
    const other = b[index];
    return other !== undefined && app.id === other.id && JSON.stringify(app) === JSON.stringify(other);
  });
}

function unchanged(a: AppsSnapshot, b: AppsSnapshot): boolean {
  return a.error === b.error && a.isLoading === b.isLoading && sameApps(a.data, b.data);
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

class AppsFeed {
  private snapshot = APPS_LOADING;
  /** Subscriber → the cadence it asked for (0 = read-only, no polling). */
  private readonly cadences = new Map<() => void, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly list: () => Promise<AppListRow[]>) {}

  read = (): AppsSnapshot => this.snapshot;

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
      // mount deserves its own first load, not a list that may be minutes old.
      this.generation += 1;
      this.snapshot = APPS_LOADING;
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
      if (generation === this.generation) this.arm();
    }
  };

  /** How many rows nobody has had rendered to them — the launcher's dot. */
  unseenCount = (): number => this.snapshot.data.filter((app) => app.unseen === true).length;

  private publish(next: AppsSnapshot): void {
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
    if (hidden()) this.stop();
    else void this.refresh();
  };
}

const feeds = new WeakMap<VendoClient, AppsFeed>();

export function appsFeed(client: VendoClient): AppsFeed {
  let feed = feeds.get(client);
  if (feed === undefined) {
    feed = new AppsFeed(() => client.apps.list());
    feeds.set(client, feed);
  }
  return feed;
}

export type { AppsFeed };
