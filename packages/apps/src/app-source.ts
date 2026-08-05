/**
 * Checkout and commit — contract §3.2.
 *
 * The workspace stops being a SECOND owner of an app's files and becomes a
 * working copy, exactly like a git checkout. Today the row's `tree` and the
 * workspace's `app.vendo` both claim to be the app, and a served app's real code
 * is only inside the sandbox snapshot — so losing the snapshot loses the app. The
 * row (id + doc) is the truth; a checkout projects it onto a filesystem and a
 * commit diffs the projection back.
 *
 * ```
 * checkoutApp(appId, workspace, ctx, seam)   → doc.tree → app.vendo, and every
 *                                              doc.source file to its path
 * edit in the workspace                     → staged in memory (the façade)
 * commitApp(appId, changed, workspace, ...)  → the changed paths land in doc.source
 * ```
 *
 * Three things this deliberately does NOT do:
 *
 * - It never touches the HOT paths. `app.vendo` and `plan.vendo` keep the render
 *   seam's behaviour exactly — checkout writes `app.vendo` because that is the
 *   projection, and commit leaves both alone because the seam already owns what
 *   happens when they land.
 * - It never invents a spill. Source past the inline cap goes through the SAME
 *   `FilesAdapter` the workspace rows spill to.
 * - It never reads or writes any field but `source`. `trigger` above all travels
 *   untouched, along with storage, machine, pins, placements and grants — a
 *   commit is not a generation.
 */
import {
  printWire,
  VendoError,
  WORKSPACE_INLINE_MAX_BYTES,
  appSourceFileSchema,
  sha256Hex,
  type AppDocument,
  type AppId,
  type AppSourceFile,
  type FilesAdapter,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import { treeOf } from "./checking/facts.js";

/** The two files the render seam owns. A checkout writes `app.vendo` as the
 *  projection of `doc.tree`; a commit never reads either back into `source`,
 *  because the seam has already turned them into the app. */
const HOT_FILES = new Set(["app.vendo", "plan.vendo"]);

/**
 * What the seam needs from the store, passed in rather than imported: `@vendoai/apps`
 * has no store dependency by design (the sandbox harness holds a workspace and
 * never a store), so composition binds these once — the same shape
 * `createAgentTools` takes its `requireOwned` through.
 */
export interface AppSourceSeam {
  /** The app row, ownership-checked. `AppsRuntime`'s own `requireOwned`. */
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /** Land a mutated document. `AppsRuntime`'s own compare-and-swap update. */
  update(appId: AppId, mutate: (doc: AppDocument) => AppDocument, ctx: RunContext): Promise<AppDocument>;
  /** The workspace's OWN blob seam, for source past {@link WORKSPACE_INLINE_MAX_BYTES}.
   *  Absent means inline-only, and an oversized file is refused loudly rather
   *  than dropped — a silently missing source file is a lost app. */
  blobs?: FilesAdapter;
}

/** The app's blob namespace: keyed by app so erasing an app erases its source. */
const blobKey = (appId: AppId, path: string): string => `apps/${appId}/${sha256Hex(path)}`;

const encoder = new TextEncoder();
const contentHash = (text: string): string => `sha256:${sha256Hex(text)}`;

/**
 * A source key is a POSIX-relative path inside the app directory, and nothing
 * else. Refused here rather than at write time because a `../` key is a checkout
 * writing outside the app — the one way this projection could reach another app's
 * files.
 */
export const invalidSourcePath = (path: string): string | null => {
  if (path.length === 0) return "a source path must not be empty";
  if (path.startsWith("/")) return `source path "${path}" must be relative to the app directory`;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `source path "${path}" must not contain empty or dot segments`;
  }
  if (HOT_FILES.has(path)) return `source path "${path}" is the render seam's, not the source tree's`;
  return null;
};

/**
 * The app's directory in THIS caller's workspace, asked out loud.
 *
 * The path layout is frozen (build contract §3.1) but which mount holds an app is
 * the workspace's answer, not ours: `canCommit` judges against live rows, and it
 * is already the one authority the materialization seam asks twice. Guessing here
 * would be a second answer to a question that has one.
 */
const appDirectory = async (appId: AppId, workspace: WorkspaceFs, ctx: RunContext): Promise<string> => {
  const candidates = [
    `/user/apps/${appId}`,
    ...(ctx.memberships ?? []).map((membership) => `/orgs/${membership.org}/apps/${appId}`),
  ];
  for (const directory of candidates) {
    if (await workspace.canCommit(`${directory}/app.vendo`)) return directory;
  }
  throw new VendoError("forbidden", `this workspace cannot hold ${appId}'s files`);
};

const sourceText = async (file: AppSourceFile, seam: AppSourceSeam, path: string): Promise<string> => {
  if (file.text !== undefined) return file.text;
  if (file.blobRef === undefined) {
    throw new VendoError("validation", `source file "${path}" carries neither text nor a blob reference`);
  }
  const blob = await seam.blobs?.get(file.blobRef);
  if (blob === undefined) {
    // The row pointed at bytes that are gone. Loud, because the alternative is a
    // checkout that silently produces a DIFFERENT app than the one stored.
    throw new VendoError("not-found", `source file "${path}" is missing its stored bytes`);
  }
  return new TextDecoder().decode(blob.bytes);
};

/**
 * Materialize the app onto the workspace: `doc.tree` as `app.vendo`, and every
 * `doc.source` entry at its path. Staged, like every workspace write — the
 * caller's `commit()` is what lands it, and for a fresh checkout nothing needs to.
 */
export async function checkoutApp(
  appId: AppId,
  workspace: WorkspaceFs,
  ctx: RunContext,
  seam: AppSourceSeam,
): Promise<void> {
  const doc = await seam.requireOwned(appId, ctx);
  const directory = await appDirectory(appId, workspace, ctx);

  const tree = treeOf(doc);
  if (tree !== undefined) {
    await workspace.writeFile(
      `${directory}/app.vendo`,
      printWire({ tree, components: doc.components ?? {}, name: doc.name }, { includeIds: true }),
    );
  }

  for (const [path, file] of Object.entries(doc.source ?? {})) {
    const invalid = invalidSourcePath(path);
    if (invalid !== null) throw new VendoError("validation", invalid);
    await workspace.writeFile(`${directory}/${path}`, await sourceText(file, seam, path));
  }
}

/**
 * Diff the changed paths of one app's directory back into `doc.source`.
 *
 * `changed` is `CommitResult.changed` verbatim — the paths that actually reached
 * the store, which is why this runs AFTER the workspace commit rather than
 * instead of it. Paths outside this app, and the two hot files, are ignored: they
 * belong to someone else.
 *
 * A path in `changed` that no longer reads is a deletion, and drops out of
 * `source`. Nothing else about the document is touched.
 */
export async function commitApp(
  appId: AppId,
  changed: readonly string[],
  workspace: WorkspaceFs,
  ctx: RunContext,
  seam: AppSourceSeam,
): Promise<void> {
  const directory = await appDirectory(appId, workspace, ctx);
  const prefix = `${directory}/`;
  const paths = changed
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter((path) => invalidSourcePath(path) === null);
  if (paths.length === 0) return;

  const landed = new Map<string, AppSourceFile>();
  const removed: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await workspace.readFile(`${prefix}${path}`);
    } catch {
      removed.push(path);
      continue;
    }
    const bytes = encoder.encode(text).byteLength;
    const hash = contentHash(text);
    if (bytes <= WORKSPACE_INLINE_MAX_BYTES) {
      landed.set(path, { hash, bytes, text });
      continue;
    }
    if (seam.blobs === undefined) {
      throw new VendoError(
        "validation",
        `source file "${path}" is ${bytes} bytes, past the ${WORKSPACE_INLINE_MAX_BYTES}-byte inline cap, and this`
        + " deployment has no files adapter to spill it to — configure one, or keep the file smaller",
      );
    }
    const key = blobKey(appId, path);
    await seam.blobs.put(key, encoder.encode(text), { contentType: "text/plain; charset=utf-8" });
    landed.set(path, { hash, bytes, blobRef: key });
  }

  await seam.update(appId, (doc) => {
    const source: Record<string, AppSourceFile> = { ...doc.source };
    for (const [path, file] of landed) {
      // Unchanged bytes are not a write: the stored hash IS the checkout base, so
      // a commit that reports a path whose content matches lands nothing.
      if (source[path]?.hash === file.hash) continue;
      source[path] = appSourceFileSchema.parse(file);
    }
    for (const path of removed) delete source[path];
    // Everything but `source` rides through untouched — `trigger` above all.
    return Object.keys(source).length === 0
      ? (({ source: _dropped, ...rest }) => rest)(doc)
      : { ...doc, source };
  }, ctx);
}
