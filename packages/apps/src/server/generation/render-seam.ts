/**
 * The hot-path render seam — build contract §1.6.
 *
 * "The skeleton renders the moment the plan file exists, whoever wrote it." The
 * runtime is the one place that knows, so the runtime is the one place that
 * emits: every store write to `app.vendo` or `plan.vendo` is parsed here and, iff
 * it parses, becomes today's `data-vendo-view` part — same payload shape, same
 * stable per-app stream id, same server-authoritative field stripping. An
 * unparseable write emits NOTHING: the last good view stays on screen and the
 * brokenness reaches the harness through `validate`, never the user.
 *
 * A parsing `app.vendo` commit is also the moment a files-first app (D4) BECOMES
 * an app: the compile goes to `AppsRuntime.authored` (the `authoredApp` seam),
 * which stores the row the person's Apps list and `vendo_apps_open` read, and
 * resolves the tree's queries so the paint carries real data instead of "—".
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
  safeErrorMessage,
  vendoViewPartSchema,
  vendoViewStreamId,
  type AppId,
  type CommitResult,
  type Json,
  type TurnId,
  type UIPayload,
  type VendoViewPart,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  compilePlan,
  compileWire,
  screenDescriptionSchema,
  type Finding,
  type Tree,
  type WireCompileResult,
  type AppFloor,
} from "../../contract/index.js";
// In-package since the seam moved home to @vendoai/apps: the plan skeleton,
// the emitted-payload assembly and the field stripping that goes with it.
import { skeletonFromPlan } from "./skeleton.js";
import { assembleTree } from "../runtime/runtime.js";
import { stripServerAuthoritativeFields } from "../persistence/open.js";

/** §1.6 — the two files that sync mid-turn. Everything else waits for turn end. */
export const HOT_PATH_FILES = ["app.vendo", "plan.vendo"] as const;

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
 * Did this content parse into something worth putting on screen?
 *
 * `compileWire` is total: unparseable input still yields a synthetic `root`
 * Stack node, so a node count is NOT the test. A childless root is exactly the
 * compiler's degraded floor — nothing to render — and putting it on the wire
 * would blank a working app.
 */
const renders = (tree: Tree): boolean => {
  const root = tree.nodes.find((node) => node.id === tree.root);
  return root !== undefined && (root.children?.length ?? 0) > 0;
};

/**
 * Which apps a commit put ON SCREEN, for the hand that wrote it.
 *
 * A landed write is not a painted screen: a document that does not compile, does
 * not render, or does not pass the checks floor lands its bytes and paints
 * nothing — and leaves no app row, because `authoredApp` runs only on a paint. A
 * hand that saved one then has no door left: `validate({appId})` is row-scoped
 * and answers "app not found" on exactly the document that needed judging (live
 * 2026-08-06). `emit` belongs to whoever wrapped the workspace, so the verdict has
 * to travel with the commit for the writer to see it at all.
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
   * Unwired, the seam behaves exactly as it did before this option existed: a bare
   * `compileWire` and no checks. That is not a mode anyone should ship — it is
   * what made every files-first paint speak a different dialect than the
   * conductor, so an inline tool reference silently lost its binding and
   * `bindingErrors` was `[]` by construction — but a `WorkspaceFs` wrapped
   * outside composition still has to work.
   */
  floor?: AppFloor;
  /**
   * The live tool/component names, for the plan compiler's fact check. Facts only
   * shape `issues` — never whether a plan parses — so omitting them costs the
   * seam nothing; composition supplies them when it has them.
   */
  facts?: () => { tools: readonly string[]; components: readonly string[] };
  /**
   * The app-runtime half of an `app.vendo` commit (§1.6) — what makes a
   * file-authored app a real app instead of a picture of one.
   *
   * Composition injects `AppsRuntime.authored`, which UPSERTS the app's store row
   * (so a files-first app lists, opens and shares like an engine-built one) and
   * resolves the tree's queries through the guard-bound registry with this turn's
   * ctx — the same call path, the same risk and consent rules, as any tool call. Its
   * answer is this app's `data`, plus `dataUnavailable` when one of those queries
   * FAILED, which is the same honest marker a thrown app half sets below.
   *
   * ASYNC on purpose: it runs real host queries, which is also why the skeleton is
   * emitted BEFORE it is awaited (below) — §1.6 is a promise about seconds.
   * Unwired, the view still renders: the skeleton, with no data and no row.
   */
  authoredApp?: (input: { appId: AppId; compiled: WireCompileResult }) => Promise<{
    data: Record<string, Json>;
    dataUnavailable?: boolean;
  } | undefined>;
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
 *  `streaming` is the mid-build flag the shipped emitter stamps on its partial
 *  trees (packages/apps runtime.ts), and it has to FLIP OFF for the last paint.
 *  While it is on, the renderer holds the forming skeleton instead of reaching a
 *  verdict, the card's bar stays on "Building your view…", and its settle-scroll,
 *  stage registration and pin affordance never arm. */
const viewPart = (
  appId: AppId,
  payload: UIPayload,
  streaming: boolean,
  turnId?: TurnId,
): { streamId: string; part: VendoViewPart } | undefined => {
  const parsed = vendoViewPartSchema.safeParse({
    type: "data-vendo-view",
    appId,
    // Spread, never mutated in place: the emitted part must not change under the
    // consumer when this function's caller fills the data in afterwards.
    payload: { ...payload, streaming },
    ...(turnId === undefined ? {} : { turnId }),
  });
  if (!parsed.success) return undefined;
  return { streamId: vendoViewStreamId(appId), part: parsed.data };
};

/** The view a parsing hot-path commit produces, or undefined if it does not parse. */
export async function viewForWrite(
  path: string,
  content: string,
  options: RenderSeamOptions,
): Promise<{ streamId: string; part: VendoViewPart } | undefined> {
  const appId = hotPathAppId(path);
  const file = hotPathFile(path);
  if (appId === undefined || file === undefined) return undefined;

  let payload: UIPayload | undefined;
  /** Set for `app.vendo` only: a plan is a skeleton, not an app document — there
   *  is nothing to store and no query to run until the app itself is written. */
  let compiledApp: WireCompileResult | undefined;
  if (file === "app.vendo") {
    // compileWire is TOTAL and valid-while-partial: every prefix of a wire
    // compiles, which is what makes a mid-generation save renderable. Only a
    // `compile-failed` issue means it truly did not parse.
    //
    // Through the FLOOR, so this compile speaks the production dialect — the same
    // one every other author speaks. Bare, an inline tool
    // reference does not expand (its binding is dropped and its query never
    // minted, and the tree still has children, so the seam paints an app with a
    // blank value) and `bindingErrors` is `[]` by construction.
    const compiled = options.floor === undefined
      ? compileWire(content)
      : await options.floor.compile(content);
    // `missing-app` means there was no `<App>` document to read at all, and
    // `compile-failed` means the compiler itself gave up: both are "unparseable".
    if (compiled.issues.some((issue) => issue.code === "compile-failed" || issue.code === "missing-app")) {
      return undefined;
    }
    if (!renders(compiled.tree)) return undefined;
    // The floor, on EVERY commit, for every author — our loop, Claude Code, a
    // human with an editor (§7.1). A `block` means this must not reach a screen,
    // and it says so the only way this seam knows how to: it emits nothing, and
    // the last good view stays. No new failure channel; the brokenness reaches the
    // author through `validate`, exactly like content that does not compile.
    if (options.floor !== undefined) {
      let findings: readonly Finding[] = [];
      try {
        findings = await options.floor.check({ appId, compiled });
      } catch (error) {
        // A floor that could not RUN is not a finding. The layer already decided
        // this question for the checks it runs — one that throws degrades to a
        // `warn` naming it, "so a broken check never takes the app down with it" —
        // and the same reasoning holds one level up: refusing every paint because
        // the host's tool probe failed would blank the pane for the whole turn,
        // which is what §1.6's skeleton exists to prevent. Loud for the operator,
        // silent for the user.
        console.error(
          `[vendo] the checks floor could not run for ${appId}, so this paint was not checked — ${safeErrorMessage(error)}`,
        );
      }
      const blocking = findings.filter((finding) => finding.severity === "block");
      if (blocking.length > 0) {
        console.error(
          `[vendo] ${appId} did not pass the checks floor; nothing painted and the last good view stays — `
          + blocking.map(({ check, where, message }) => [
            check === undefined ? undefined : `[${check}]`,
            where,
            message,
          ].filter((part) => part !== undefined).join(" ")).join("; "),
        );
        return undefined;
      }
    }
    compiledApp = compiled;
    payload = stripServerAuthoritativeFields(
      assembleTree({ tree: compiled.tree, components: compiled.components }),
    ) as unknown as UIPayload;
  } else {
    const facts = options.facts?.() ?? { tools: [], components: [] };
    const compiled = compilePlan(content, facts);
    if (compiled.plan === undefined) return undefined;
    // The plan format IS the render format: its skeleton is the view.
    const skeleton = skeletonFromPlan(compiled.plan);
    if (!renders(skeleton.tree)) return undefined;
    // Redesign spec §5: the plan's arrival posture, forwarded the moment the plan
    // file parses — which is the whole point of hinting at plan time, since the
    // stage has to be open while the skeleton is still worth watching. Absent
    // stays absent: the client reads undefined as inline, so a plan written
    // before this field existed keeps behaving exactly as it did. Only the plan
    // carries it; later `app.vendo` saves say nothing about display and must not
    // be read as a retraction.
    payload = stripServerAuthoritativeFields(assembleTree({
      tree: skeleton.tree,
      ...(compiled.plan.display === undefined ? {} : { display: compiled.plan.display }),
    })) as unknown as UIPayload;
  }

  // Contract §3.3 — nothing paints that is not a valid `ScreenDescription`. This
  // is where the view channel's shape becomes enforced rather than described: an
  // emission that does not parse emits NOTHING, which is the law this seam
  // already lives by for content that does not compile.
  const description = screenDescriptionSchema.safeParse(payload);
  if (!description.success) {
    console.error(
      `[vendo] ${appId}'s compiled screen is not a valid description; nothing painted — ${
        description.error.issues[0]?.message ?? "unknown"
      }`,
    );
    return undefined;
  }

  // A plan IS the mid-build state: its skeleton stays streaming until the app
  // document itself lands.
  if (compiledApp === undefined) return viewPart(appId, payload, true, options.turnId);
  // "The skeleton renders the moment the plan file exists" is a promise about
  // SECONDS, and the app half runs real host queries. So the skeleton goes out
  // first and the same stream id is written again when the data lands — the
  // engine's own progressive behavior, and the reason successive views reconcile
  // in place instead of stacking.
  if (options.authoredApp !== undefined) {
    const skeleton = viewPart(appId, payload, true, options.turnId);
    if (skeleton !== undefined) options.emit(skeleton.streamId, skeleton.part);
  }
  let data: Record<string, Json> | undefined;
  /**
   * The app half FAILED, as opposed to answering with nothing. Settling alone is
   * honest about the spinner and dishonest about the data: every unresolved binding
   * renders "—" (packages/ui branded.tsx), so a failed load is indistinguishable
   * from "you have no spending". The operator gets the log below; without this
   * marker the user gets a plausible lie. So the failure rides the payload as a
   * server-written extra, the same channel `inClient` and `pinDrift` ride.
   */
  let dataUnavailable = false;
  try {
    const authored = await options.authoredApp?.({ appId, compiled: compiledApp });
    data = authored?.data;
    // A query that failed is the common case and a throw is the rare one: same
    // marker, because on screen they are the same failure.
    if (authored?.dataUnavailable === true) dataUnavailable = true;
  } catch (error) {
    // The streaming skeleton is ALREADY on screen, so rethrowing would leave the
    // card stuck on "Building your view…" forever — the exact symptom the settle
    // flag exists to prevent. `authored` can genuinely throw: its own store reads
    // and hold checks run before its internal try.
    dataUnavailable = true;
    console.error(
      `[vendo] the app half of ${appId} failed; the view settles without its data — ${safeErrorMessage(error)}`,
    );
  }
  // The app half has run: this is the finished paint, so it SETTLES.
  return viewPart(appId, {
    ...payload,
    // §3.3's `data` law is about the DESCRIPTION, which was gated above without
    // it. This resolved data is the shipped first-paint fill, and it rides
    // BESIDE the description until Track A moves the query path into the slot —
    // at which point this spread is the thing that gets deleted, and the gate
    // above is already the wall that stops it coming back.
    ...(data === undefined ? {} : { data }),
    ...(dataUnavailable ? { dataUnavailable: true } : {}),
  }, false, options.turnId);
}

/**
 * Wrap a workspace so a commit that lands a hot-path file emits its view. Every
 * other operation passes straight through, so the result is still a `WorkspaceFs`.
 */
export function wrapWorkspaceForRender(workspace: WorkspaceFs, options: RenderSeamOptions): WorkspaceFs {
  /** True iff this path put a view on screen — what the plan's yield is keyed on. */
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
   * reasons. §1.6 is a promise about seconds, and — the load-bearing one — an
   * `app.vendo` commit is the moment a files-first app BECOMES an app: the
   * `authoredApp` seam above is what upserts its row. Running source persistence
   * first would look for a row that does not exist yet.
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
        // Both hot-path files of one app write the SAME stream id, so a commit
        // carrying both would have the plan's data-less skeleton land as one of the
        // two views — and `changed` is sorted, so `app.vendo` goes first and the
        // plan would overwrite the finished app with a picture of it. The app
        // document is the better view by definition, so plans go LAST — but they
        // still paint unless their own app actually did, because an `app.vendo` that
        // does not parse or does not render emits nothing, and yielding to it would
        // leave the pane blank for the whole turn.
        const plans: Array<{ path: string; appId: AppId }> = [];
        const painted = new Set<AppId>();
        for (const path of result.changed) {
          const appId = hotPathAppId(path);
          if (appId === undefined) continue;
          if (hotPathFile(path) === "plan.vendo") plans.push({ path, appId });
          else if (await emitFor(path)) painted.add(appId);
        }
        for (const { path, appId } of plans) {
          if (!painted.has(appId) && await emitFor(path)) painted.add(appId);
        }
        await persistSource(result.changed);
        paintedByCommit.set(result, [...painted]);
        return result;
      };
    },
  });
}
