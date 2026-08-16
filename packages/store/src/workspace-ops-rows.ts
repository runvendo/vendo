import { VendoError, type StoreOps } from "@vendoai/core";
import { iso } from "./helpers/utils.js";
import type {
  CommitAllResult,
  WorkspaceFileMeta,
  WorkspaceHistoryEntry,
  WorkspaceRows,
} from "./workspace-rows.js";

/**
 * The workspace pair over the 42-op contract instead of this store's own
 * Postgres — what makes a hosted store (a key, no database) serve the same
 * `WorkspaceStoreFs` a local one does, byte for byte. The façade above
 * (workspace.ts) is unchanged, and so are its permission checks: `can()` reads
 * through the records door, which the hosted store already serves.
 *
 * Two shapes differ from the SQL backend and both are deliberate:
 *   - **Content is JSON on the wire**, so text files ride as a JSON string and
 *     anything that is not valid UTF-8 rides the {@link WORKSPACE_BYTES_KEY}
 *     base64 envelope. Encoding a PNG as a lossy string was the alternative.
 *   - **Revisions come from the caller.** The wire's commit answers `ok`, not a
 *     new revision, so `land` reports the checked-out revision plus one — which
 *     is exactly what the server assigns, and where it is not (a racing writer
 *     on a `/user` mount) the next turn's index reads the truth. Strict mounts
 *     never guess: their commit carries `expectedRevision`, and a lost swap
 *     comes back `conflict`.
 */

/** The binary envelope: a workspace file whose bytes are not text travels as
    `{"$vendoWorkspaceBytes": "<base64>"}`. A plain JSON string is text. */
const WORKSPACE_BYTES_KEY = "$vendoWorkspaceBytes";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

/** Bytes → the JSON the wire carries: the string itself when the content is
    text, the base64 envelope when it is not. */
function workspaceBytesToJson(bytes: Uint8Array): unknown {
  try {
    const text = utf8.decode(bytes);
    if (!text.includes("\u0000")) return text;
  } catch {
    // not UTF-8 — fall through to the envelope
  }
  return { [WORKSPACE_BYTES_KEY]: bytesToBase64(bytes) };
}

/** The wire's JSON → bytes. A value that is neither a string nor an envelope
    was written by something other than a workspace filesystem (a direct
    `ops.workspace.commit` of a JSON document), and reads as its JSON text —
    exactly the bytes the SQL backend stores for the same commit. */
function workspaceJsonToBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  const envelope = (data as Record<string, unknown> | null)?.[WORKSPACE_BYTES_KEY];
  if (typeof envelope === "string") return base64ToBytes(envelope);
  return encoder.encode(JSON.stringify(data));
}

/** Promote's workspace half is one transaction with the app-row flip, so a
    hosted store runs the whole move server-side (`lifecycle.promote`) and never
    reaches this backend — but a silent no-op would strand an app's documents. */
const notWiredYet = (verb: string): never => {
  throw new VendoError(
    "not-implemented",
    `a hosted workspace cannot ${verb}: that move runs server-side, through lifecycle.promote`,
  );
};

/** One commit from the wire's path-scoped history. `revision` is the revision
    the path held BEFORE that commit — absent when the commit created it, which
    is a version boundary with nothing behind it (the SQL backend has no history
    row for a create either, which is why both answer `empty` there). */
interface PathCommit {
  commitId: string;
  revision?: number;
  at: string;
}

const pathCommitOf = (entry: unknown): PathCommit | undefined => {
  const row = entry as Record<string, unknown> | null;
  if (typeof row?.["commitId"] !== "string") return undefined;
  const revision = row["revision"];
  return {
    commitId: row["commitId"],
    ...(typeof revision === "number" ? { revision } : {}),
    at: iso(row["at"] ?? new Date(0).toISOString()),
  };
};

/** One `workspace.index` page as file metas. Shared by the paging read below
    and by {@link workspaceIndexPage}, so a batched index and a fanned-out one
    cannot describe the same rows differently. */
const metasOf = (entries: readonly unknown[], owner: string): WorkspaceFileMeta[] => {
  const metas: WorkspaceFileMeta[] = [];
  for (const entry of entries) {
    const row = entry as Record<string, unknown>;
    if (typeof row["path"] !== "string") continue;
    metas.push({
      path: row["path"],
      owner,
      bytes: Number(row["bytes"] ?? 0),
      revision: Number(row["revision"] ?? 0),
      updatedAt: iso(row["updatedAt"] ?? new Date(0).toISOString()),
    });
  }
  return metas;
};

/** `turn.load`'s index page, as the metas `workspaceStore.open` would have read
    for this owner — or UNDEFINED when the page left a cursor behind. The
    per-owner read below pages to exhaustion, and half an index is not an index:
    a caller handed one back would open a turn whose workspace is missing files.
    Undefined is that caller's signal to read it the ordinary way. */
export function workspaceIndexPage(
  page: { entries: readonly unknown[]; cursor?: string },
  owner: string,
): WorkspaceFileMeta[] | undefined {
  return page.cursor === undefined ? metasOf(page.entries, owner) : undefined;
}

export function workspaceOpsRows(ops: StoreOps): WorkspaceRows {
  const readOne = async (owner: string, path: string): Promise<unknown | undefined> => {
    const files = await ops.workspace.read([path], { owner });
    return path in files ? files[path] : undefined;
  };

  /** The commits that touched one path, newest first. */
  const pathCommits = async (owner: string, path: string): Promise<PathCommit[]> => {
    const commits: PathCommit[] = [];
    let cursor: string | undefined;
    do {
      const page = await ops.workspace.history({
        owner,
        path,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.entries) {
        const commit = pathCommitOf(entry);
        if (commit !== undefined) commits.push(commit);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return commits;
  };

  /** One owner's whole path index. */
  const indexOf = async (owner: string): Promise<WorkspaceFileMeta[]> => {
    const metas: WorkspaceFileMeta[] = [];
    let cursor: string | undefined;
    do {
      const page = await ops.workspace.index({
        owner,
        ...(cursor === undefined ? {} : { cursor }),
      });
      metas.push(...metasOf(page.entries, owner));
      cursor = page.cursor;
    } while (cursor !== undefined);
    return metas;
  };

  return {
    async index(owners) {
      const metas: WorkspaceFileMeta[] = [];
      for (const owner of owners) metas.push(...await indexOf(owner));
      return metas.sort((left, right) => (left.path < right.path ? -1 : 1));
    },

    async read(owner, path) {
      const data = await readOne(owner, path);
      return data === undefined ? undefined : workspaceJsonToBytes(data);
    },

    async prepare(owner, path, bytes) {
      const current = await readOne(owner, path);
      if (current !== undefined && sameBytes(workspaceJsonToBytes(current), bytes)) {
        return "unchanged";
      }
      // Nothing is placed remotely until `land` commits: the wire has no
      // staging area, so there is no blob to orphan and `discard` is free.
      return {
        path,
        content: bytes,
        bytes: bytes.byteLength,
        // The server assigns the real revision; `land` reports it from the
        // revision the caller checked out.
        revision: 0,
        stored: { content: undefined, blobRef: undefined },
        prior: undefined,
      };
    },

    async land(owner, prepared, _intent, options) {
      // The commit message has no field on the wire; it is a history label, and
      // history is S3's leg.
      // A strict mount guards EVERY write, the create included: a caller who
      // checked out nothing sends `expectedRevision: null` ("this path must not
      // exist yet"), which is exactly the state `WorkspaceStoreFs.commit` is in
      // for a path it never read. Requiring a number here degraded that case
      // into an unguarded write, so the hosted backend silently overwrote the
      // colleague who created the file first while the SQL backend refused.
      const strict = options?.strict === true;
      const expectedRevision = options?.expectedRevision ?? null;
      const checkedOut = typeof options?.expectedRevision === "number" ? options.expectedRevision : 0;
      try {
        await ops.workspace.commit(
          [{
            path: prepared.path,
            data: workspaceBytesToJson(prepared.content),
            ...(strict ? { expectedRevision } : {}),
          }],
          { owner },
        );
      } catch (error) {
        // §9.7 — a strict mount's lost swap is the frozen conflict branch, not
        // a failure: the façade re-reads the new head and re-applies.
        if (strict && error instanceof VendoError && error.code === "conflict") {
          return {
            landed: false,
            revision: checkedOut,
            updatedAt: new Date().toISOString(),
            conflict: true,
          };
        }
        throw error;
      }
      return { landed: true, revision: checkedOut + 1, updatedAt: new Date().toISOString() };
    },

    /** The whole turn in ONE `workspace.commit` — the wire has been
        array-shaped all along, and the per-path loop this replaces paid a round
        trip per file. Per-entry `expectedRevision` rides along unchanged, so
        the strict mounts keep their compare-and-swap and a stale one still
        refuses the WHOLE commit. */
    async commitAll(owner, entries, _intent) {
      const wire: unknown[] = [];
      const landed: CommitAllResult["landed"] = [];
      const removed: string[] = [];
      const guarded = new Map<string, number | null>();
      for (const entry of entries) {
        if ("delete" in entry) {
          // The wire's tombstone never says whether a row was there, and the
          // façade counts only real removals — so ask, exactly as the per-path
          // remove did.
          if ((await readOne(owner, entry.path)) === undefined) continue;
          wire.push({ path: entry.path, delete: true });
          removed.push(entry.path);
          continue;
        }
        if (entry.strict) guarded.set(entry.path, entry.expectedRevision);
        wire.push({
          path: entry.path,
          data: workspaceBytesToJson(entry.write.content),
          ...(entry.strict ? { expectedRevision: entry.expectedRevision } : {}),
        });
        landed.push({
          // The server assigns the real revision; this is the checked-out one
          // plus one, exactly as the per-path `land` reported it.
          path: entry.path,
          revision: (entry.expectedRevision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
          changed: true,
        });
      }
      if (wire.length === 0) return { conflicts: [], landed: [], removed: [] };
      try {
        await ops.workspace.commit(wire, { owner });
      } catch (error) {
        if (!(error instanceof VendoError) || error.code !== "conflict") throw error;
        // §9.7 — a lost swap is the frozen conflict branch, not a failure. The
        // refusal names no path on the wire (the error envelope carries a code
        // and a message, nothing else), so read the heads back and re-run the
        // server's own comparison: nothing landed, so a guarded path whose head
        // is not what this turn checked out is precisely one that moved.
        const heads = new Map((await indexOf(owner)).map((meta) => [meta.path, meta.revision]));
        const conflicts = [...guarded]
          .filter(([path, at]) => (heads.get(path) ?? null) !== at)
          .map(([path]) => path);
        // A conflict under no moved path is not this branch — it is the
        // idempotency ledger refusing a reused key, and it belongs to the caller.
        if (conflicts.length === 0) throw error;
        return { conflicts, landed: [], removed: [] };
      }
      return { conflicts: [], landed, removed };
    },

    async discard() {
      // Nothing was staged remotely, so there is nothing to release.
    },

    async remove(owner, path, _intent) {
      if ((await readOne(owner, path)) === undefined) return false;
      await ops.workspace.commit([{ path, delete: true }], { owner });
      return true;
    },

    async moveApp() {
      return notWiredYet("move an app between mounts");
    },

    async history(owner, path): Promise<WorkspaceHistoryEntry[]> {
      const entries: WorkspaceHistoryEntry[] = [];
      for (const commit of await pathCommits(owner, path)) {
        // A commit that created the path is not a version you can go back TO,
        // so it is not one of the path's superseded revisions.
        if (commit.revision === undefined) continue;
        // The wire carries no commit message, so the label is the commit id —
        // which is exactly what the ops backend stamps its writes with.
        entries.push({ revision: commit.revision, intent: commit.commitId, at: commit.at });
      }
      return entries;
    },

  };
}
