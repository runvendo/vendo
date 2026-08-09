/**
 * Materialization + diff sync-back — build contract §3.5, verbatim law.
 *
 * A sandboxed harness gets a real disk, so the workspace has to leave the store
 * and come back. Checkout writes the caller's visible files out; sync-back is
 * **diff-based, per file, never wholesale** — only paths whose content hash
 * changed are committed. Each mount's `scratch/` never syncs. The hot paths
 * (`app.vendo`, `plan.vendo`) sync MID-TURN, which is what puts the skeleton on
 * screen; everything else lands at turn end.
 *
 * **Permission is the workspace's, never this file's** (§9.3, design §8): every
 * question about who may write what is `workspace.canCommit(path)`, asked
 * per file at the two moments `can()` runs on the sandbox path — checkout, to
 * decide whether a file lands read-only on the disk, and sync-back, against live
 * rows, to decide whether a changed file goes home. A hardcoded path table
 * stood here through wave 3 and answered for `/orgs/**` mounts it had never
 * heard of, which made every team file invisible to `claudeCode()` and dropped
 * every edit to one with no error anywhere.
 *
 * This file is deliberately harness-agnostic and transport-agnostic: it moves
 * bytes between a `WorkspaceFs` and a plain path→bytes list. `claudeCode()` is
 * its first caller; `codex()` is its second.
 *
 * Landing bytes and calling `commit()` is the WHOLE mid-turn render story — the
 * render seam (`@vendoai/apps` render-seam.ts) wraps `commit` and emits the
 * view, so this file never speaks about views.
 */
import { createHash } from "node:crypto";
import { hotPathAppId } from "@vendoai/apps";
import type { WorkspaceFs } from "@vendoai/core";

/** §3.1's frozen mounts: `/host`, `/user`, and one `/orgs/<org>` per asserted
 *  membership. A path outside them is not the workspace and never reaches a
 *  machine's disk, whatever a `getAllPaths()` reports. */
const IN_MOUNT = /^\/(?:host|user|orgs\/[^/]+)(?:\/|$)/;

/**
 * Does a machine's whole-tree walk carry this path home? `/host` is the
 * deployment's own files, projected per turn, so it never comes back.
 *
 * A SHAPE, and deliberately not a permission — it is the only question a walk of
 * a real disk can answer, because a disk has no store to ask. Both machines ask
 * it: `claude-code/local.ts` here, and the box door's own copy in
 * `packages/apps/box/turn-routes.mjs`. Whether a carried path may LAND is
 * `canCommit`'s, per file, against live rows.
 */
export const inWritableMount = (path: string): boolean =>
  /^\/(?:user|orgs\/[^/]+)\//.test(normalize(path));

/** §3.1: intra-turn junk. Visible on the machine's disk, never in the store —
 *  one per writable mount, because a turn working in an org mount has the same
 *  throwaway files a personal turn does and committing them would publish them
 *  to the whole team. Identical to the façade's own rule (`workspace-fs.ts`). */
const SCRATCH = /^(?:\/user|\/orgs\/[^/]+)\/scratch(?:\/|$)/;

/**
 * Resolve `.`/`..` and collapse slashes, exactly as the store façade's own
 * `normalizePath` does. The box hands back path STRINGS from a real disk walk,
 * so `/user/../etc/passwd` is a shape that can arrive; judging it unresolved
 * would call it a `/user` path and let it out of the mount.
 */
function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** SHA-256 of the bytes — the §3.5 diff key. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One file as the box receives it.
 *
 * `readOnly` is PER FILE, not per mount (§3.5 over §9.7): `/host` is read-only
 * for everyone, and inside an org mount a file the caller holds only viewer on
 * lands read-only beside an editable one. That is what stops the model doing
 * work the sync-back would have to throw away — it meets the refusal when it
 * reaches for the file, not after it has rewritten it.
 */
export interface CheckoutFile {
  path: string;
  bytes: Uint8Array;
  readOnly: boolean;
}

/** One file as the box hands it back. */
export interface SyncFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * What a machine's disk is KNOWN to hold — the baseline every sync-back diffs
 * against, persisted for the life of one conversation.
 *
 * It exists because a warm box is not re-materialized between turns (that is
 * what makes turn 2 free), so its tree dates from conversation start. Diffing
 * turn-end contents against a FRESH store read instead would compare the box's
 * copy to a store someone else may have moved underneath it: a file changed
 * out-of-band (another thread of the same user, an app tool, an automation)
 * hash-mismatches the box's stale copy and gets written BACK, destroying the
 * newer state; an out-of-band delete gets resurrected. Measured, then pinned.
 *
 * With this baseline, "unchanged in the box" means SKIP — the store keeps
 * whatever it has — and only what the box actually changed is written.
 */
export interface TreeState {
  /** Syncable path → content hash the machine's disk holds. */
  hashes: Map<string, string>;
  /** Checked-out paths the box walk cannot carry back — see WALK_SKIP_BYTES. */
  oversized: Set<string>;
}

export const emptyTree = (): TreeState => ({ hashes: new Map(), oversized: new Set() });

export interface WorkspaceCheckout {
  /** Every file this caller may see, filtered at checkout — the box is born
   *  filtered, because there are no checks inside it (design §8). */
  readonly files: readonly CheckoutFile[];
  /** The baseline this checkout is diffing against, so the caller can persist it
   *  alongside the machine that now holds that tree. */
  readonly tree: TreeState;
  /**
   * Mid-turn sync of the hot paths only. Never deletes: a mid-turn view of the
   * box's disk is a snapshot of work in progress, not a statement about what the
   * user still owns.
   */
  syncHot(files: readonly SyncFile[]): Promise<string[]>;
  /**
   * Turn-end sync. Every changed writable path lands, and a file that was in the
   * checkout and is absent now is deleted — `rm` in the box is a real edit.
   */
  syncAll(files: readonly SyncFile[]): Promise<string[]>;
}

/**
 * The box door's whole-tree walk skips files over this to protect the proxy's
 * body limit (`packages/apps/box/turn-routes.mjs`), so a machine can report a
 * checked-out file ABSENT while still holding it. Under the default files
 * store (5 MiB cap) no checked-out file reaches this size; a BYO adapter (s3)
 * has no cap. Absent-means-deleted must not apply to such a file: keeping a
 * stale copy after a rare real in-box `rm` beats destroying the store's only
 * copy on every turn that touches nothing.
 */
const WALK_SKIP_BYTES = 8 * 1024 * 1024;

export async function checkoutWorkspace(
  workspace: WorkspaceFs,
  /** The machine's persisted baseline, filled in place when `reseed`. */
  tree: TreeState = emptyTree(),
  /**
   * True when the machine's disk is about to be materialized FROM this checkout,
   * so the baseline is derived here — after materialize the box holds exactly
   * what the store just handed it.
   *
   * False for a WARM machine, whose tree already IS the truth about its disk. The
   * store is then deliberately not consulted for the baseline: it may have moved
   * underneath the box, and the box's stale copy must never be written back over
   * the newer state. That is the whole stale-clobber fix.
   */
  reseed = true,
): Promise<WorkspaceCheckout> {
  const files: CheckoutFile[] = [];
  const { hashes, oversized } = tree;
  if (reseed) {
    hashes.clear();
    oversized.clear();
  }

  /** May a path the machine hands back actually LAND? The workspace is the only
   *  authority; scratch is the one thing above it, because a throwaway file is
   *  writable and still must never reach the store (§3.1). */
  const syncable = async (path: string): Promise<boolean> =>
    !SCRATCH.test(path) && await workspace.canCommit(path);

  for (const path of workspace.getAllPaths()) {
    // A path in no mount is not the workspace — a `getAllPaths()` that reports
    // one (a test double, a future alias) must not put it on a machine's disk.
    if (!IN_MOUNT.test(path)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await workspace.readFileBuffer(path);
    } catch {
      // `getAllPaths()` reports directories too, and a directory is not a file
      // to materialize. Nothing else can fail here that the box needs to hear
      // about — a file it cannot read simply is not on its disk.
      continue;
    }
    // Per FILE, from the real `can()`: an org app the caller holds viewer on
    // lands read-only beside a team file they may edit.
    const writable = await workspace.canCommit(path);
    files.push({ path, bytes, readOnly: !writable });
    if (reseed && writable && !SCRATCH.test(path)) {
      hashes.set(path, contentHash(bytes));
      if (bytes.length > WALK_SKIP_BYTES) oversized.add(path);
    }
  }

  const apply = async (
    incoming: readonly SyncFile[],
    options: { hotOnly: boolean; deleteMissing: boolean },
  ): Promise<string[]> => {
    const seen = new Set<string>();
    const staged = new Map<string, string>();
    for (const entry of incoming) {
      // The seam judges the RESOLVED path, and the resolved path is what the
      // store is keyed by — one canonical name, whoever wrote it (§3.1).
      const path = normalize(entry.path);
      seen.add(path);
      // Live rows, per path — the SECOND of the two moments `can()` runs on the
      // sandbox path (design §8/§9.3). It re-asks rather than trusting the
      // checkout because a grant revoked mid-session must bite here, and because
      // a process running as the file's owner can chmod a read-only checkout
      // back. The refusal the model MEETS is the read-only mode on its disk;
      // this is the backstop that makes it true, and it stays a skip so one
      // refused org path can never take the caller's own work down with it.
      if (!(await syncable(path))) continue;
      if (options.hotOnly && hotPathAppId(path) === undefined) continue;
      const hash = contentHash(entry.bytes);
      if (hashes.get(path) === hash) continue;
      await workspace.writeFile(path, entry.bytes);
      staged.set(path, hash);
    }

    const removed: string[] = [];
    if (options.deleteMissing) {
      for (const path of hashes.keys()) {
        if (seen.has(path)) continue;
        // Absent because the walk cannot carry it, not because anyone deleted
        // it — see WALK_SKIP_BYTES.
        if (oversized.has(path)) continue;
        // A deletion is a write, so it asks the same live question. Only a
        // mid-session revoke can fail here (the baseline holds nothing that was
        // not writable at checkout), and `commit()` would refuse it by THROWING
        // — taking the caller's own landed work down with it.
        if (!(await syncable(path))) continue;
        await workspace.rm(path, { force: true });
        removed.push(path);
      }
    }

    if (staged.size === 0 && removed.length === 0) return [];
    const result = await workspace.commit();
    // A conflict means nothing landed (§3.2): the checkout's view of the store is
    // unchanged, so the next sync retries the same diff.
    if (result.status !== "ok") return [];
    for (const [path, hash] of staged) hashes.set(path, hash);
    for (const path of removed) hashes.delete(path);
    // `removed` are paths that WERE in the checkout, so their rows existed and
    // the deletion landed; the union is deduped because a façade that reports
    // removals in `changed` (the shipped one does) would otherwise list twice.
    return [...new Set([...result.changed, ...removed])].sort();
  };

  return {
    files,
    tree,
    syncHot: (incoming) => apply(incoming, { hotOnly: true, deleteMissing: false }),
    syncAll: (incoming) => apply(incoming, { hotOnly: false, deleteMissing: true }),
  };
}
