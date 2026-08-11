// `IFileSystem` is vendored into ./filesystem.ts rather than imported from
// just-bash: it leaks into core's published .d.ts, and a dependency there
// would put ~50 MB of bash interpreter into every SDK install for a shape.
// The runtime dependency belongs to whoever runs bash (@vendoai/harnesses).
import type { IFileSystem } from "./filesystem.js";

/** Build contract §3.2 — the agent's filesystem. just-bash's `IFileSystem`
    implemented over the store (`workspaceStore(store).open(principal)` in
    `@vendoai/store`), so a machine-less harness gets in-process bash
    (grep/sed/awk/jq) over the same files a sandboxed harness sees on disk.
    Path layout is frozen (§3.1):

      /user/apps/<appId>/{app,plan}.vendo · /user/memory/ · /user/files/
      /user/scratch/ (intra-turn; never committed) · /host/** (read-only)

    Writes are staged in memory and land in the store on `commit()` — that is
    what keeps the store write law (O(files changed), never O(writes)). */
export interface WorkspaceFs extends IFileSystem {
  /** Commit changed files. Per-mount rules: /orgs = CAS, /user = last write wins. */
  commit(opts?: { message?: string }): Promise<CommitResult>;
  /**
   * Build contract §9.3 — may this caller land a write at `path`, judged against
   * LIVE rows? `/host` and anything outside the caller's mounts answer false;
   * inside `/orgs/<org>/apps/<appId>/**` the app's own grants decide, so a
   * viewer-level team file answers false while its neighbour answers true.
   *
   * It exists on the FILESYSTEM because a sandboxed harness holds a workspace
   * and never a store (§3.5): the materialization seam asks it twice — at
   * checkout, to decide whether a file lands on the box's disk read-only, and at
   * sync-back, to decide whether a changed file may go home. Both are the same
   * question `commit()` asks itself; one authority, asked out loud.
   */
  canCommit(path: string): Promise<boolean>;
}

/** Build contract §3.2. `conflict` is the /orgs compare-and-swap outcome
    (wave 3); /user is last-write-wins and always resolves `ok`. */
export type CommitResult =
  | { status: "ok"; changed: string[] }
  | { status: "conflict"; paths: string[] };

/** Build contract §3.4 — the blob seam under the workspace: files past the
    inline cap live here, keyed by the store's `blob_ref`. Unset, the store's
    own `blobs()` backs it (capped); past that cap the host brings its own via
    `files:` on createVendo (any S3-compatible bucket) — nothing ships one. */
export interface FilesAdapter {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
}

/**
 * Build contract §9.7 — which mount holds an app's documents: a person's
 * `/user`, or an org's `/orgs/<org>`.
 *
 * Owner and path prefix always travel together, so naming the mount is the whole
 * address — and that is exactly why an app's address must be derived from its
 * OWNERSHIP and never from which candidate path happens to be writable. An
 * org-owned app's editor can usually write their own `/user` mount too, so
 * permission cannot tell the two apart; ownership can.
 *
 * It lives here, beside `WorkspaceFs`, because it now has two readers:
 * `@vendoai/store` (which moves an app between mounts) and `@vendoai/apps`
 * (which projects one into a workspace and reads it back).
 */
export type AppMount =
  | { kind: "user"; subject: string }
  | { kind: "org"; org: string };

/** The app's own root path in a mount, with NO trailing slash: the subtree hangs
 *  off it, and it is itself a path a row can sit at. ONE derivation of the frozen
 *  §3.1 layout, so a projection and a move can never disagree about an address. */
export const appRootPath = (mount: AppMount, appId: string): string =>
  mount.kind === "user" ? `/user/apps/${appId}` : `/orgs/${mount.org}/apps/${appId}`;

/** Build contract §3.4 — the line between "inline in the row" and "in a blob".
 *
 *  It lives here, beside the two shapes it governs, because it now has two
 *  readers: `@vendoai/store`'s workspace rows and `@vendoai/apps`'s app source
 *  (contract §3.2). A source file and a workspace file spill at the same size
 *  because they are the same bytes in two projections; two constants would be two
 *  answers to one question. */
export const WORKSPACE_INLINE_MAX_BYTES = 65_536;
