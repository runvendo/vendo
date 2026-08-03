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
    own `blobs()` backs it (capped); `s3()` is the one shipped implementation. */
export interface FilesAdapter {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
}
