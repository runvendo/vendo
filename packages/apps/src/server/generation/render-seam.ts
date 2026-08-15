/**
 * The hot-path render seam — build contract §1.6.
 *
 * The runtime is the one place that knows a screen landed, so the runtime is the
 * one place that emits: every store write to `app.tsx` goes through the checks
 * floor's component gauntlet here and, iff it paints, becomes today's
 * `data-vendo-view` part — same payload shape, same stable per-app stream id,
 * same server-authoritative field stripping. A write that does not paint emits
 * NOTHING: the last good view stays on screen and the brokenness reaches the
 * harness through `validate`, never the user.
 *
 * `HarnessEvent` stays closed — a harness cannot yield a view, by construction.
 *
 * The interception point is **`commit()`** (orchestrator seam answer, 2026-07-30,
 * after lane B landed): the workspace façade STAGES writes in memory, so a
 * `writeFile` is not a store write — `commit()` is, and `CommitResult.changed`
 * names exactly the paths that reached the store. Hooking the write instead would
 * emit views for content that never landed, and would miss the sandbox sync-back
 * path, which commits without ever calling `writeFile` on this façade.
 *
 * That last clause is why the app's own SOURCE is persisted from here too
 * (contract §2.2/§3.2, the `commitSource` seam): a builder working inside a box
 * reaches the store through this same `commit()`, so this is the one place that
 * sees its files at all. Before it, an app's code lived only in the sandbox
 * snapshot behind `machine.snapshotRef` — lose the snapshot, lose the app.
 */
import {
  vendoViewPart,
  type AppId,
  type CommitResult,
  type TurnId,
  type UIPayload,
  type VendoViewPart,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  screenDescriptionSchema,
  type AppFloor,
  stripServerAuthoritativeFields,
} from "../../contract/index.js";
// In-package since the seam moved home to @vendoai/apps: the emitted-payload
// assembly and the field stripping that goes with it.
import { assembleTree } from "../runtime/runtime.js";

/** §1.6 — the file that syncs mid-turn. Everything else waits for turn end. */
export const HOT_PATH_FILES = ["app.tsx"] as const;

/** §3.1, frozen: `/user/apps/<appId>/**` and — since wave 3 (§9.7) —
 *  `/orgs/<orgId>/apps/<appId>/**`. `appId` is the store's app id verbatim in
 *  BOTH, which is exactly why one regex can read either: a path's meaning never
 *  depends on who wrote it, so a promoted app's hot paths must keep painting the
 *  skeleton mid-turn like a personal one's.
 *
 *  ONE regex for the whole layout, with the file left as a tail: the hot paths and
 *  the source tree are the same two addresses with different names hanging off
 *  them, and two regexes would be two answers to "which app is this?". */
const APP_PATH = /^\/(?:user|orgs\/[^/]+)\/apps\/(app_[^/]+)\/(.+)$/;

/** The appId a write ANYWHERE inside an app's directory belongs to, hot path or
 *  not — what source persistence asks of a commit's changed list. */
const appPathAppId = (path: string): AppId | undefined => {
  const match = APP_PATH.exec(path);
  return match === null ? undefined : (match[1] as AppId);
};

/**
 * §3.5's hot paths as WATCH SHAPES — what a machine's mid-turn collect asks for,
 * where `*` stands for exactly one segment (both machines' rule).
 *
 * BOTH mounts, for the same reason `HOT_PATH` reads either: a team app's
 * skeleton has to paint mid-turn like a personal one's. Watching only
 * `/user/apps/*` left an `/orgs` app with nothing to sync until turn end — a
 * blank pane for the length of the turn instead of a skeleton in seconds.
 *
 * Shapes, never a list of files that already exist: on the one ask the skeleton
 * exists for ("make me an app") the appId is invented DURING the turn, so an
 * enumeration watches nothing at all — measured 52.8s of silence against 5.0s.
 */
export const HOT_PATH_WATCH: readonly string[] = ["/user/apps/*", "/orgs/*/apps/*"]
  .flatMap((prefix) => HOT_PATH_FILES.map((name) => `${prefix}/${name}`));

const hotPathFile = (path: string): (typeof HOT_PATH_FILES)[number] | undefined => {
  const tail = APP_PATH.exec(path)?.[2];
  return HOT_PATH_FILES.find((name) => name === tail);
};

/** The appId a hot-path write belongs to, or undefined if this is not one. */
export function hotPathAppId(path: string): AppId | undefined {
  return hotPathFile(path) === undefined ? undefined : appPathAppId(path);
}


/**
 * Which apps a commit put ON SCREEN, for the hand that wrote it.
 *
 * A landed write is not a painted screen: a screen that does not pass the checks
 * floor lands its bytes and paints nothing — and leaves no app row, because the
 * gauntlet's own `ok` is what creates it. A hand that saved one then has no door
 * left: `validate({appId})` is row-scoped and answers "app not found" on exactly
 * the document that needed judging (live 2026-08-06). `emit` belongs to whoever
 * wrapped the workspace, so the verdict has to travel with the commit for the
 * writer to see it at all.
 *
 * BESIDE the result rather than on it: the wrapper passes the store's answer
 * through untouched, and a `CommitResult` is what the store said, not what the
 * seam did with it.
 */
const paintedByCommit = new WeakMap<CommitResult, readonly AppId[]>();

/** The apps `result`'s commit painted, or undefined for a result this seam did not
 *  produce — which is "not known", never "nothing painted". */
export const paintedIn = (result: CommitResult): readonly AppId[] | undefined =>
  paintedByCommit.get(result);

export interface RenderSeamOptions {
  /** Write the part on the stable per-app stream id, so successive views
   *  reconcile in place instead of stacking. */
  emit: (streamId: string, part: VendoViewPart) => void;
  /**
   * The checks floor (§7.1) — the production compile dialect, and the
   * deterministic fact checks over what it compiled.
   *
   * INJECTED rather than imported. The floor's implementation needs a catalog,
   * tool shapes and a model, none of which a bare `WorkspaceFs` wrap can know.
   * Composition builds it — `AppsRuntime.floor(ctx)` — which is the only layer
   * that HAS those things.
   *
   * Unwired, this build carries no screen engine: nothing paints, and a
   * `WorkspaceFs` wrapped outside composition still has to work.
   */
  floor?: AppFloor;
  /**
   * Contract §2.2/§3.2 — persist the app's own SOURCE for a commit that landed.
   *
   * The same interception point as a view, for the same reason plus one: the
   * sandbox sync-back path (`materialize.ts`) commits without ever calling
   * `writeFile` on this façade, so a builder working inside a box reaches the
   * store HERE and nowhere else. Hooking the write instead would persist content
   * that never landed and miss the box entirely.
   *
   * `changed` is `CommitResult.changed` verbatim — the paths that actually reached
   * the store. Called once per APP the commit touched, because `commitApp` is
   * per-app and one commit can carry several; it does its own prefix filtering, so
   * the whole list rides every call. `workspace` is the real façade underneath this
   * wrapper, which is what the diff reads the landed bytes back through.
   *
   * Composition injects `AppsRuntime.commitSource` (see `packages/vendo/server.ts`),
   * which binds `commitApp` to the app row's ownership, its compare-and-swap
   * update, and the deployment's files adapter for blob spill.
   *
   * UNWIRED, source is not persisted: `machine.snapshotRef` stays the only home an
   * app's code has, which is exactly today's behaviour — so no host regresses, and
   * no host is protected either.
   */
  commitSource?: (input: {
    appId: AppId;
    changed: readonly string[];
    workspace: WorkspaceFs;
  }) => Promise<void>;
  /** The turn this seam is painting inside, stamped on every view it emits so a
   *  screen joins back to the exchange that made it. Absent outside a turn. */
  turnId?: TurnId;
}

/** The view part for a payload, or undefined when the renderer's own gate would
 *  reject it — a payload it would not render is not a view, and a half-rendered
 *  app is worse than the last good one.
 *
 *  `streaming: false` because the gauntlet has already run: while that flag is
 *  on, the renderer holds the forming skeleton instead of reaching a verdict, the
 *  card's bar stays on "Building your view…", and its settle-scroll, stage
 *  registration and pin affordance never arm. */
const viewPart = (
  appId: AppId,
  payload: UIPayload,
  turnId?: TurnId,
): { streamId: string; part: VendoViewPart } | undefined =>
  vendoViewPart({ appId, payload: { ...payload, streaming: false }, ...(turnId === undefined ? {} : { turnId }) });

/** The view a landed hot-path commit produces, or undefined if it does not paint. */
export async function viewForWrite(
  path: string,
  content: string,
  options: RenderSeamOptions,
): Promise<{ streamId: string; part: VendoViewPart } | undefined> {
  const appId = hotPathAppId(path);
  if (appId === undefined || hotPathFile(path) === undefined) return undefined;

  // The component gauntlet lives behind the floor, like every other check —
  // the seam never learns how to read TSX. No door means this build carries
  // no screen engine: nothing paints, the last good view stays.
  const door = options.floor?.component?.bind(options.floor);
  if (door === undefined) return undefined;
  const result = await door({ appId, source: content });
  if (!result.ok) {
    console.error(
      `[vendo] ${appId} did not pass the checks floor; nothing painted and the last good view stays — `
      + result.blocking.join("; "),
    );
    return undefined;
  }
  const payload = stripServerAuthoritativeFields(
    assembleTree({ tree: { nodes: Object.values(result.nodes), root: result.root } }),
  ) as unknown as UIPayload;
  (payload as { interactive?: unknown }).interactive = result.interactive;

  // Contract §3.3 — nothing paints that is not a valid `ScreenDescription`. This
  // is where the view channel's shape becomes enforced rather than described: an
  // emission that does not parse emits NOTHING, which is the law this seam
  // already lives by for a screen the gauntlet refused.
  const description = screenDescriptionSchema.safeParse(payload);
  if (!description.success) {
    console.error(
      `[vendo] ${appId}'s compiled screen is not a valid description; nothing painted — ${
        description.error.issues[0]?.message ?? "unknown"
      }`,
    );
    return undefined;
  }
  // The gauntlet already ran its queries, so this paint is FINAL.
  return viewPart(appId, payload, options.turnId);
}

/**
 * Wrap a workspace so a commit that lands a hot-path file emits its view. Every
 * other operation passes straight through, so the result is still a `WorkspaceFs`.
 */
export function wrapWorkspaceForRender(workspace: WorkspaceFs, options: RenderSeamOptions): WorkspaceFs {
  /** True iff this path put a view on screen. */
  const emitFor = async (path: string): Promise<boolean> => {
    try {
      // Read back what the store now holds rather than trusting a remembered
      // argument: append, encoding and any store-side normalization land here.
      const content = await workspace.readFile(path);
      const view = await viewForWrite(path, content, options);
      if (view === undefined) return false;
      options.emit(view.streamId, view.part);
      return true;
    } catch {
      // A view is a courtesy on top of a landed commit. It can never fail one.
      return false;
    }
  };

  /**
   * Land the source of every app this commit touched — AFTER the views, for two
   * reasons. §1.6 is a promise about seconds, and — the load-bearing one — the
   * paint is the moment a files-first app BECOMES an app: the gauntlet's own
   * `ok` is what upserts its row (`AppFloor.component` → `authoredScreen`).
   * Running source persistence first would look for a row that does not exist yet.
   *
   * It can never fail the commit either, for the same reason a view cannot. But
   * unlike a view, a silently dropped source file is a LOST APP — the snapshot
   * being the only other home is the whole problem this closes — so the failure is
   * LOUD, in the same voice as the runtime's own commit failure.
   */
  const persistSource = async (changed: readonly string[]): Promise<void> => {
    if (options.commitSource === undefined) return;
    const apps = new Set<AppId>();
    for (const path of changed) {
      const appId = appPathAppId(path);
      if (appId !== undefined) apps.add(appId);
    }
    for (const appId of apps) {
      try {
        await options.commitSource({ appId, changed, workspace });
      } catch (error) {
        console.error("[vendo] render seam: source did not reach the store", {
          appId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return new Proxy(workspace, {
    // `receiver` is deliberately NOT forwarded to Reflect.get: a method read off
    // the proxy and then called would run with `this` === proxy, and any real
    // façade using `#private` fields (lane B's may) throws on the first access.
    // Binding to the target keeps `this` the real object, which also stops writes
    // from re-entering this trap.
    get(target, property) {
      if (property !== "commit") {
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      const original = Reflect.get(target, property) as
        | ((opts?: { message?: string }) => Promise<CommitResult>)
        | undefined;
      if (typeof original !== "function") return original;
      return async (opts?: { message?: string }): Promise<CommitResult> => {
        const result = await original.call(target, opts);
        // A conflict means nothing landed — the harness re-reads and re-applies,
        // and the last good view stays on screen until something actually does.
        if (result.status !== "ok") return result;
        const painted = new Set<AppId>();
        for (const path of result.changed) {
          const appId = hotPathAppId(path);
          if (appId !== undefined && await emitFor(path)) painted.add(appId);
        }
        await persistSource(result.changed);
        paintedByCommit.set(result, [...painted]);
        return result;
      };
    },
  });
}
