/**
 * Checkout and commit — contract §3.2.
 *
 * The workspace is a working COPY, not a second owner: the row (id + doc) is the
 * truth, a checkout projects it onto a filesystem, and a commit diffs the
 * projection back.
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
  VendoError,
  WORKSPACE_INLINE_MAX_BYTES,
  appRootPath,
  safeErrorMessage,
  sha256Hex,
  type AppId,
  type AppMount,
  type FilesAdapter,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  printWire,
  appSourceFileSchema,
  type AppDocument,
  type AppSourceFile,
} from "../../contract/index.js";
import { treeOf } from "../checking/facts.js";

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
  /**
   * The app row's OWNER — a person's subject, or an org id. It is what decides
   * the app's ADDRESS (§9.7: owner and path prefix always travel together), and
   * it is the one question a workspace cannot answer: an org app's editor can
   * usually write their own `/user` mount too, so permission cannot tell the two
   * addresses apart.
   */
  ownerOf(appId: AppId, ctx: RunContext): Promise<string>;
  /** The workspace's OWN blob seam, for source past {@link WORKSPACE_INLINE_MAX_BYTES}.
   *  Absent means inline-only, and an oversized file is refused loudly rather
   *  than dropped — a silently missing source file is a lost app. */
  blobs?: FilesAdapter;
}

/**
 * The mount that HOLDS an app, from its owner (§9.7).
 *
 * An owner the caller holds a membership for is an ORG; anything else is a
 * person's own subject. Never a guess: a personal app shared with this caller
 * resolves to its OWNER's `/user` mount, which the caller then genuinely cannot
 * commit to — an honest refusal instead of a write in the wrong place.
 */
export const appMountFor = (owner: string, ctx: RunContext): AppMount =>
  (ctx.memberships ?? []).some((membership) => membership.org === owner)
    ? { kind: "org", org: owner }
    : { kind: "user", subject: owner };

/**
 * The app's blob namespace. Keyed by app and by PATH, so every version of a path
 * shares one key: a re-commit overwrites in place, and nothing deletes these
 * blobs — not the `removed` loop below and not app deletion. Minting a fresh key
 * per write is what would make a delete safe (see `workspace-rows.ts`), and it is
 * the prerequisite for reaping them.
 */
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
 * The app's directory: derived from OWNERSHIP, then permission-checked.
 *
 * Permission cannot choose an address; only the owner can. Picking the first
 * WRITABLE mount instead sends an org-owned app whose editor can also write their
 * own `/user` mount to the personal mount, and every edit under
 * `/orgs/<org>/apps/<appId>` is then filtered out and silently dropped.
 * `canCommit` is the gate, never the chooser.
 */
const appDirectory = async (
  appId: AppId,
  workspace: WorkspaceFs,
  ctx: RunContext,
  seam: AppSourceSeam,
): Promise<string> => {
  const mount = appMountFor(await seam.ownerOf(appId, ctx), ctx);
  // The frozen §3.1 layout cannot spell ANOTHER person's personal mount: `/user`
  // is always the caller's own and `appRootPath` drops the subject, so without
  // this refusal a foreign personal app resolves to the CALLER's rows while
  // commitApp writes back to someone else's — and `canCommit` cannot catch it,
  // because it only ever answers about the caller's own mount. Team apps go
  // through the org mount, where the org IS in the path.
  if (mount.kind === "user" && mount.subject !== ctx.principal.subject) {
    throw new VendoError("forbidden", `${appId} lives in another person's workspace`);
  }
  const directory = appRootPath(mount, appId);
  if (!(await workspace.canCommit(`${directory}/app.vendo`))) {
    throw new VendoError("forbidden", `this workspace cannot hold ${appId}'s files at ${directory}`);
  }
  return directory;
};

/**
 * The file's content, PROVEN to be the content the row describes.
 *
 * `hash` is the CAS base — a commit diffs against it to decide what changed — so
 * content that disagrees with it is not a smaller problem than content that is
 * missing: both make a checkout produce a different app than the one stored, and
 * "an app can always be rebuilt from its row" is the promise this contract exists
 * to keep. The document validator cannot catch it (it sees field shapes, and
 * never the blob's bytes at all), so the check belongs here, at the moment the
 * bytes and their claimed identity are both in hand.
 *
 * Fails CLOSED. Hashing every file on checkout costs one pass over bytes we have
 * already read and are about to write.
 */
const sourceText = async (file: AppSourceFile, seam: AppSourceSeam, path: string): Promise<string> => {
  const text = await storedText(file, seam, path);
  const bytes = encoder.encode(text).byteLength;
  if (bytes !== file.bytes) {
    throw new VendoError(
      "conflict",
      `source file "${path}" is ${bytes} bytes but its row says ${file.bytes} — refusing to check out content that is not the content stored`,
    );
  }
  const hash = contentHash(text);
  if (hash !== file.hash) {
    throw new VendoError(
      "conflict",
      `source file "${path}" hashes to ${hash} but its row says ${file.hash} — refusing to check out content that is not the content stored`,
    );
  }
  return text;
};

const storedText = async (file: AppSourceFile, seam: AppSourceSeam, path: string): Promise<string> => {
  if (file.text !== undefined) return file.text;
  if (file.blobRef === undefined) {
    throw new VendoError("validation", `source file "${path}" carries neither text nor a blob reference`);
  }
  const blob = await seam.blobs?.get(file.blobRef);
  if (blob === undefined) {
    // The row pointed at bytes that are gone. Loud, for the same reason as above.
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
  const directory = await appDirectory(appId, workspace, ctx, seam);

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
 * A path in `changed` that no longer EXISTS is a deletion, and drops out of
 * `source`. A path that is still there and merely would not READ is a fault, and
 * keeps its stored entry — stale beats gone. Nothing else about the document is
 * touched.
 */
export async function commitApp(
  appId: AppId,
  changed: readonly string[],
  workspace: WorkspaceFs,
  ctx: RunContext,
  seam: AppSourceSeam,
): Promise<void> {
  const directory = await appDirectory(appId, workspace, ctx, seam);
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
    } catch (error) {
      // "Would not read" is not "was deleted". A spilled file's read-back is a LIVE
      // fetch from the files adapter, so a blob store having a bad minute looks
      // exactly like a deletion — and dropping the entry loses a source file, the
      // one outcome "the row is the truth" cannot survive.
      //
      // `exists()` is the discriminator and the thrown error deliberately is not:
      // the façade raises the same POSIX-shaped ENOENT either way and carries no
      // code to switch on, while `exists()` answers from the row index without
      // touching the blob. Per PATH, not per commit — the other files still land.
      if (await workspace.exists(`${prefix}${path}`)) {
        console.error(
          `[vendo] source file "${path}" of ${appId} is still there but would not read back;`
          + ` its stored entry is KEPT rather than dropped — ${safeErrorMessage(error)}`,
        );
        continue;
      }
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
