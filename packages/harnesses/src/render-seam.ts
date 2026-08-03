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
 * `HarnessEvent` stays closed — a harness cannot yield a view, by construction.
 *
 * The interception point is **`commit()`** (orchestrator seam answer, 2026-07-30,
 * after lane B landed): the workspace façade STAGES writes in memory, so a
 * `writeFile` is not a store write — `commit()` is, and `CommitResult.changed`
 * names exactly the paths that reached the store. Hooking the write instead would
 * emit views for content that never landed, and would miss the sandbox sync-back
 * path, which commits without ever calling `writeFile` on this façade.
 */
import {
  compilePlan,
  compileWire,
  vendoViewPartSchema,
  vendoViewStreamId,
  type AppId,
  type CommitResult,
  type Json,
  type Tree,
  type UIPayload,
  type VendoViewPart,
  type WorkspaceFs,
} from "@vendoai/core";
// `skeletonFromPlan` was already public before this lane; the payload-assembly
// pair is a cross-block internal.
import { skeletonFromPlan } from "@vendoai/apps";
import { assembleTree, stripServerAuthoritativeFields } from "@vendoai/apps/internal";

/** §1.6 — the two files that sync mid-turn. Everything else waits for turn end. */
export const HOT_PATH_FILES = ["app.vendo", "plan.vendo"] as const;

/** §3.1, frozen: `/user/apps/<appId>/app.vendo` and — since wave 3 (§9.7) —
 *  `/orgs/<orgId>/apps/<appId>/app.vendo`. `appId` is the store's app id
 *  verbatim in BOTH, which is exactly why one regex can read either: a path's
 *  meaning never depends on who wrote it, so a promoted app's hot paths must
 *  keep painting the skeleton mid-turn like a personal one's. */
const HOT_PATH = /^\/(?:user|orgs\/[^/]+)\/apps\/(app_[^/]+)\/(app\.vendo|plan\.vendo)$/;

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

/** The appId a hot-path write belongs to, or undefined if this is not one. */
export function hotPathAppId(path: string): AppId | undefined {
  const match = HOT_PATH.exec(path);
  return match === null ? undefined : (match[1] as AppId);
}

const hotPathFile = (path: string): (typeof HOT_PATH_FILES)[number] | undefined => {
  const match = HOT_PATH.exec(path);
  return match === null ? undefined : (match[2] as (typeof HOT_PATH_FILES)[number]);
};

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

export interface RenderSeamOptions {
  /** Write the part on the stable per-app stream id, so successive views
   *  reconcile in place instead of stacking. */
  emit: (streamId: string, part: VendoViewPart) => void;
  /**
   * The live tool/component names, for the plan compiler's fact check. Facts only
   * shape `issues` — never whether a plan parses — so omitting them costs the
   * seam nothing; composition supplies them when it has them.
   */
  facts?: () => { tools: readonly string[]; components: readonly string[] };
  /**
   * Progressive query-resolver fill (§1.6). The real resolver is
   * `createProgressiveQueryResolver` in `packages/apps`, which needs the app's
   * caller and document — neither of which a committed file carries — so
   * composition injects it and the seam awaits it. ASYNC on purpose: the shipped
   * resolver runs real queries, so a synchronous signature could never wire it in.
   * Unwired, the view still renders: the skeleton first, data when the app's own
   * open path resolves it.
   */
  fillData?: (appId: AppId, payload: UIPayload) => Promise<Record<string, Json> | undefined>;
}

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
  if (file === "app.vendo") {
    // compileWire is TOTAL and valid-while-partial: every prefix of a wire
    // compiles, which is what makes a mid-generation save renderable. Only a
    // `compile-failed` issue means it truly did not parse.
    const compiled = compileWire(content);
    // `missing-app` means there was no `<App>` document to read at all, and
    // `compile-failed` means the compiler itself gave up: both are "unparseable".
    if (compiled.issues.some((issue) => issue.code === "compile-failed" || issue.code === "missing-app")) {
      return undefined;
    }
    if (!renders(compiled.tree)) return undefined;
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
    payload = stripServerAuthoritativeFields(
      assembleTree({ tree: skeleton.tree }),
    ) as unknown as UIPayload;
  }

  const data = await options.fillData?.(appId, payload);
  if (data !== undefined) payload.data = data;
  // `streaming: true`, exactly as the shipped emitter stamps its partial trees
  // (packages/apps runtime.ts). Without it the renderer treats a mid-build tree as
  // a FINISHED one and shows "Invalid UI tree" while the app is still growing —
  // the skeleton experience depends on this flag, not just on the payload.
  payload.streaming = true;
  // The renderer's own gate decides what reaches the wire — a payload it would
  // reject is not a view, and a half-rendered app is worse than the last good one.
  const parsed = vendoViewPartSchema.safeParse({ type: "data-vendo-view", appId, payload });
  if (!parsed.success) return undefined;
  return { streamId: vendoViewStreamId(appId), part: parsed.data };
}

/**
 * Wrap a workspace so a commit that lands a hot-path file emits its view. Every
 * other operation passes straight through, so the result is still a `WorkspaceFs`.
 */
export function wrapWorkspaceForRender(workspace: WorkspaceFs, options: RenderSeamOptions): WorkspaceFs {
  const emitFor = async (path: string): Promise<void> => {
    if (hotPathAppId(path) === undefined) return;
    try {
      // Read back what the store now holds rather than trusting a remembered
      // argument: append, encoding and any store-side normalization land here.
      const content = await workspace.readFile(path);
      const view = await viewForWrite(path, content, options);
      if (view !== undefined) options.emit(view.streamId, view.part);
    } catch {
      // A view is a courtesy on top of a landed commit. It can never fail one.
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
        for (const path of result.changed) await emitFor(path);
        return result;
      };
    },
  });
}
