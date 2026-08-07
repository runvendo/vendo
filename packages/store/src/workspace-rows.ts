import { WORKSPACE_INLINE_MAX_BYTES, appRootPath, VendoError, type AppMount, type FilesAdapter, type IsoDateTime } from "@vendoai/core";
import type { Db } from "./db.js";
import { escapeLike, iso, text } from "./helpers/utils.js";

/** Build contract §3.3 — inline in `content` up to this size; past it the row
    carries a `blob_ref` into the files adapter instead. */
export { WORKSPACE_INLINE_MAX_BYTES } from "@vendoai/core";

/** Build contract §3.3 — retention per path, same as app history. */
export const WORKSPACE_HISTORY_LIMIT = 50;

/** Build contract §9.7 — the mount type and the one derivation of an app's root
    path both live in core now: `@vendoai/apps` projects an app into a workspace
    and has to compute the same address this file moves rows between. */
export type { AppMount } from "@vendoai/core";

const mountOwner = (mount: AppMount): string =>
  mount.kind === "user" ? mount.subject : mount.org;


/** The two tables an app's documents live in; both move together. */
const WORKSPACE_TABLES = ["vendo_workspace_files", "vendo_workspace_history"] as const;

/** One file's metadata. Content is fetched separately (it may live in a blob). */
export interface WorkspaceFileMeta {
  path: string;
  owner: string;
  bytes: number;
  revision: number;
  updatedAt: IsoDateTime;
}

/** One superseded revision: which revision it was, and why it was replaced.
    The content itself stays behind the table — nothing reads it, and fetching
    it here would mean one blob read per entry. */
export interface WorkspaceHistoryEntry {
  revision: number;
  intent?: string;
  at: IsoDateTime;
}

/**
 * A blob key is a random id and nothing else. The ROW is the pointer: keys
 * derived from owner/path/revision were guessable across tenants, and they
 * broke every operation that moves a row without rewriting content (adoption
 * flips `owner`, so an owner-keyed blob became unreachable by the new owner's
 * erase). Random ids make `blob_ref` the single source of truth, which is what
 * lets every delete path collect exactly the blobs it orphans.
 */
const mintBlobRef = (): string => `wsb_${globalThis.crypto.randomUUID()}`;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The `content` column is text, so bytes only go inline when they ARE text:
 *  valid UTF-8, no NUL. Anything else (uploads, images) takes the blob path
 *  regardless of size — which is also where every oversized document goes. */
function inlineText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > WORKSPACE_INLINE_MAX_BYTES) return undefined;
  let decoded: string;
  try {
    decoded = utf8.decode(bytes);
  } catch {
    return undefined; // not UTF-8 — store as a blob
  }
  return decoded.includes("\u0000") ? undefined : decoded;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

interface StoredContent {
  content: string | undefined;
  blobRef: string | undefined;
}

interface Current {
  revision: number;
  bytes: number;
  updatedAt: IsoDateTime;
  stored: StoredContent;
}

/**
 * A write whose content is already placed (inline decided, blob uploaded) but
 * whose rows have not been touched yet — the unit `commit()` preflights with.
 * Everything that can deterministically fail (an over-cap file, an adapter
 * refusal) fails while producing one of these, so a commit either lands every
 * file or writes no row at all.
 */
export interface PreparedWrite {
  path: string;
  /** The content itself, kept so a lost CAS can re-aim at the new head without
      re-placing the blob (the bytes have not changed — only the base has). */
  content: Uint8Array;
  bytes: number;
  revision: number;
  stored: StoredContent;
  prior: Current | undefined;
}

/** Row-level access to the workspace pair (build contract §3.3). Content lands
 *  inline or in the files adapter; every overwrite appends the superseded
 *  revision to history. */
export interface WorkspaceRows {
  /** The path index the façade builds at turn start (§3.2). */
  index(owners: string[]): Promise<WorkspaceFileMeta[]>;
  read(owner: string, path: string): Promise<Uint8Array | undefined>;
  /** Place the content and reserve a revision, touching no row. `unchanged`
      means the bytes are already stored: no revision bump, nothing to sync. */
  prepare(owner: string, path: string, bytes: Uint8Array): Promise<PreparedWrite | "unchanged">;
  /** Land a prepared write atomically: one statement compare-and-swaps the file
      row against the revision `prepare` read AND records the superseded revision,
      so two overlapping commits can never both claim the same revision number.
      A lost race re-aims at the new head and retries here — /user stays
      last-write-wins for the final content, and the loser's edit still lands as
      a history row. `landed: false` means the head already holds these exact
      bytes, so this commit wrote nothing. */
  land(
    owner: string,
    prepared: PreparedWrite,
    intent?: string,
    /** Build contract §9.7 — `/orgs` commits are STRICT compare-and-swap: one
        attempt, no re-aim. A lost swap comes back `conflict: true` (and its
        blob is released) so the façade can answer the frozen conflict branch
        instead of overwriting a colleague's edit. */
    options?: {
      strict?: boolean;
      /** The revision this turn CHECKED OUT (contract §3.5) — null when the
          file did not exist then. Strict mounts swap against this, not against
          whatever the head happens to be at commit time, or a commit would
          quietly overwrite an edit that landed mid-turn. */
      expectedRevision?: number | null;
    },
  ): Promise<{ landed: boolean; revision: number; updatedAt: IsoDateTime; conflict?: true }>;
  /** Drop a prepared write that will never land, so its blob is not orphaned. */
  discard(prepared: PreparedWrite): Promise<void>;
  /** Deleting records what it removed, because history is append-only (§3.3).
      Returns false if there was nothing there. */
  remove(owner: string, path: string, intent?: string): Promise<boolean>;
  /** Build contract §9.5 — promote's workspace half: move one app's documents
      between mounts (`/user/apps/<id>/**` owned by a person and
      `/orgs/<org>/apps/<id>/**` owned by the org). Owner AND path change
      together, because owner derivation is a pure function of the path (§9.7);
      history moves with the files, or the trail would point at unreachable rows.
      Both directions, so the umbrella's promote can put the documents back
      when the row flip that follows them fails. A destination that already
      holds these paths is refused BEFORE anything moves. Returns how many file
      rows moved. */
  moveApp(appId: string, from: AppMount, to: AppMount): Promise<number>;
  history(owner: string, path: string): Promise<WorkspaceHistoryEntry[]>;
}

export function workspaceRows(db: Db, files: FilesAdapter): WorkspaceRows {
  const load = async (stored: StoredContent): Promise<Uint8Array | undefined> => {
    if (stored.content !== undefined) return encode(stored.content);
    if (stored.blobRef === undefined) return undefined;
    return (await files.get(stored.blobRef))?.bytes;
  };

  const storedOf = (row: Record<string, unknown>): StoredContent => ({
    content: typeof row["content"] === "string" ? row["content"] : undefined,
    blobRef: typeof row["blob_ref"] === "string" ? row["blob_ref"] : undefined,
  });

  const dropBlob = async (stored: StoredContent): Promise<void> => {
    if (stored.blobRef !== undefined) await files.delete(stored.blobRef);
  };

  /** Drop `stored` unless `keep` is the same blob. Two writers can place the
   *  same bytes and end up holding the same key, and the loser must not release
   *  what the winner has just made the live file's only copy — that would leave
   *  a row pointing at nothing. Whoever still points at a blob keeps it. */
  const release = async (stored: StoredContent, keep: StoredContent): Promise<void> => {
    if (stored.blobRef !== keep.blobRef) await dropBlob(stored);
  };

  const currentOf = async (owner: string, path: string): Promise<Current | undefined> => {
    const result = await db.query(
      `SELECT content, blob_ref, revision, bytes, updated_at FROM vendo_workspace_files
       WHERE path = $1 AND owner = $2`,
      [path, owner],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      revision: Number(row["revision"]),
      bytes: Number(row["bytes"]),
      updatedAt: iso(row["updated_at"]),
      stored: storedOf(row),
    };
  };

  /** Revisions are monotonic per path for its whole life — including across a
   *  delete, so a re-created file never reuses a number history still holds
   *  (which would make `ORDER BY revision DESC` surface stale revisions first). */
  const highestRevision = async (owner: string, path: string): Promise<number> => {
    const result = await db.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(revision) FROM vendo_workspace_files WHERE path = $1 AND owner = $2), 0),
         COALESCE((SELECT MAX(revision) FROM vendo_workspace_history WHERE path = $1 AND owner = $2), 0)
       ) AS revision`,
      [path, owner],
    );
    return Number(result.rows[0]?.["revision"] ?? 0);
  };

  const appendHistory = async (
    owner: string,
    path: string,
    superseded: Current,
    intent: string | undefined,
    at: IsoDateTime,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO vendo_workspace_history (id, path, owner, revision, content, blob_ref, intent, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        `wsh_${globalThis.crypto.randomUUID()}`,
        path,
        owner,
        superseded.revision,
        superseded.stored.content ?? null,
        superseded.stored.blobRef ?? null,
        intent ?? null,
        at,
      ],
    );
  };

  /** Retention (§3.3): keep the newest WORKSPACE_HISTORY_LIMIT revisions. */
  const trim = async (owner: string, path: string): Promise<void> => {
    const dropped = await db.query(
      `DELETE FROM vendo_workspace_history WHERE id IN (
         SELECT id FROM vendo_workspace_history WHERE path = $1 AND owner = $2
         ORDER BY revision DESC OFFSET $3
       ) RETURNING content, blob_ref`,
      [path, owner, WORKSPACE_HISTORY_LIMIT],
    );
    for (const row of dropped.rows) await dropBlob(storedOf(row));
  };

  /** Put the bytes where they belong and hand back the two column values. */
  const place = async (bytes: Uint8Array): Promise<StoredContent> => {
    const inline = inlineText(bytes);
    if (inline !== undefined) return { content: inline, blobRef: undefined };
    const key = mintBlobRef();
    await files.put(key, bytes);
    return { content: undefined, blobRef: key };
  };

  /**
   * One statement: compare-and-swap the file row against the revision `prepare`
   * read, and — only if that swap won — record the revision it superseded.
   *
   * Both halves must be atomic together. Appending history first would leave a
   * bogus row behind whenever the swap loses; swapping first and appending after
   * would leave a window where a crash loses the superseded revision. A
   * data-modifying CTE does both or neither.
   */
  const swapRow = async (
    owner: string,
    prepared: PreparedWrite,
    options: { intent?: string },
    now: IsoDateTime,
  ): Promise<boolean> => {
    const values = [
      prepared.path,
      owner,
      prepared.stored.content ?? null,
      prepared.stored.blobRef ?? null,
      prepared.bytes,
      prepared.revision,
      now,
    ];
    if (prepared.prior === undefined) {
      // No row when we looked: we win only if we are the one that creates it.
      const created = await db.query(
        `INSERT INTO vendo_workspace_files (path, owner, content, blob_ref, bytes, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (path, owner) DO NOTHING
         RETURNING revision`,
        values,
      );
      return created.rows.length > 0;
    }
    const prior = prepared.prior;
    const result = await db.query(
      `WITH swapped AS (
         UPDATE vendo_workspace_files
            SET content = $3, blob_ref = $4, bytes = $5, revision = $6, updated_at = $7
          WHERE path = $1 AND owner = $2 AND revision = $8
          RETURNING revision
       ), logged AS (
         INSERT INTO vendo_workspace_history (id, path, owner, revision, content, blob_ref, intent, at)
         SELECT $9, $1, $2, $8, $10, $11, $12, $7
         WHERE EXISTS (SELECT 1 FROM swapped)
       )
       SELECT COUNT(*)::int AS swapped FROM swapped`,
      [
        ...values,
        prior.revision,
        `wsh_${globalThis.crypto.randomUUID()}`,
        prior.stored.content ?? null,
        prior.stored.blobRef ?? null,
        options.intent ?? null,
      ],
    );
    return Number(result.rows[0]?.["swapped"] ?? 0) > 0;
  };

  /** How many times a lost race re-aims before giving up. Overlap is expected
   *  (§3.5 syncs hot paths mid-turn); a queue this deep is a real conflict. */
  const SWAP_ATTEMPTS = 5;

  /** The write path. /user is last-write-wins for the FINAL content (§3.2), but
   *  a loser's edit still lands — at its own revision, above the winner's. */
  const landRow = async (
    owner: string,
    initial: PreparedWrite,
    options: {
      intent?: string;
      strict?: boolean;
      expectedRevision?: number | null;
    },
  ): Promise<{ landed: boolean; revision: number; updatedAt: IsoDateTime; conflict?: true }> => {
    let prepared = initial;
    if (options.strict === true
      && (prepared.prior?.revision ?? null) !== (options.expectedRevision ?? null)) {
      // The head moved between checkout and commit: the base this write was
      // built on is gone, so the swap is refused before it is attempted.
      await dropBlob(prepared.stored);
      return {
        landed: false,
        revision: prepared.prior?.revision ?? 0,
        updatedAt: prepared.prior?.updatedAt ?? new Date().toISOString(),
        conflict: true,
      };
    }
    const attempts = options.strict === true ? 1 : SWAP_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const now = new Date().toISOString();
      if (await swapRow(owner, prepared, options, now)) {
        await trim(owner, prepared.path);
        return { landed: true, revision: prepared.revision, updatedAt: now };
      }
      // Someone else moved the head. Re-aim at it: same bytes, same blob, new
      // base and a fresh revision above whatever is there now.
      const head = await currentOf(owner, prepared.path);
      if (head !== undefined) {
        const settled = await load(head.stored);
        if (settled !== undefined && sameBytes(settled, prepared.content)) {
          // The winner stored exactly these bytes, so there is nothing left to
          // write — and our blob is surplus, unless the winner is the one now
          // pointing at it.
          await release(prepared.stored, head.stored);
          return { landed: false, revision: head.revision, updatedAt: head.updatedAt };
        }
      }
      if (options.strict === true) {
        // §9.7 — strict mounts do not re-aim. Release the blob this write
        // placed (nothing points at it) and report the loss; the harness
        // re-reads the new head and re-applies.
        await dropBlob(prepared.stored);
        return {
          landed: false,
          revision: head?.revision ?? prepared.revision,
          updatedAt: head?.updatedAt ?? new Date().toISOString(),
          conflict: true,
        };
      }
      prepared = {
        ...prepared,
        revision: (await highestRevision(owner, prepared.path)) + 1,
        prior: head,
      };
    }
    throw new VendoError(
      "conflict",
      `${prepared.path} is being written faster than it can settle`
        + ` (${SWAP_ATTEMPTS} attempts); retry the turn`,
    );
  };

  return {
    async index(owners) {
      const result = await db.query(
        `SELECT path, owner, bytes, revision, updated_at FROM vendo_workspace_files
         WHERE owner = ANY($1::text[]) ORDER BY path ASC`,
        [owners],
      );
      return result.rows.map((row) => ({
        path: text(row["path"]),
        owner: text(row["owner"]),
        bytes: Number(row["bytes"]),
        revision: Number(row["revision"]),
        updatedAt: iso(row["updated_at"]),
      }));
    },

    async read(owner, path) {
      const current = await currentOf(owner, path);
      return current === undefined ? undefined : await load(current.stored);
    },

    async prepare(owner, path, bytes) {
      const prior = await currentOf(owner, path);
      // A different length cannot be the same content, so the common case (an
      // edit) never pays for the prior content — which for a blob is a GET.
      if (prior !== undefined && prior.bytes === bytes.byteLength) {
        const stored = await load(prior.stored);
        if (stored !== undefined && sameBytes(stored, bytes)) return "unchanged";
      }
      return {
        path,
        content: bytes,
        bytes: bytes.byteLength,
        revision: (await highestRevision(owner, path)) + 1,
        stored: await place(bytes),
        prior,
      };
    },

    async land(owner, prepared, intent, options) {
      return await landRow(owner, prepared, {
        ...(intent === undefined ? {} : { intent }),
        ...(options?.strict === true ? { strict: true } : {}),
        ...(options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      });
    },

    async discard(prepared) {
      await dropBlob(prepared.stored);
    },

    async remove(owner, path, intent) {
      const current = await currentOf(owner, path);
      if (current === undefined) return false;
      // History is append-only (§3.3): the delete records what it removed, so
      // the blob stays — the history row is its pointer now.
      await appendHistory(owner, path, current, intent, new Date().toISOString());
      await db.query("DELETE FROM vendo_workspace_files WHERE path = $1 AND owner = $2", [path, owner]);
      await trim(owner, path);
      return true;
    },

    async moveApp(appId, from, to) {
      const before = appRootPath(from, appId);
      const after = appRootPath(to, appId);
      // TWO anchors per mount, exactly as erase.byApp matches: the subtree, and
      // the app's own root row at exactly `…/apps/<appId>` — the path core's
      // `appOfOrgPath` says the app's grants govern, which a slash-suffixed LIKE
      // never matched, so a promote left it behind in the promoter's `/user`.
      const anchored = `(path LIKE $2 ESCAPE '\\' OR path = $3)`;
      const subtree = `${escapeLike(before)}/%`;
      // The destination is checked FIRST, across both tables: `vendo_workspace_files`
      // is keyed (path, owner), so a collision would fail the UPDATE mid-move and
      // strand half the app. Refuse in the caller's own words instead — a promote
      // is all-or-nothing (§9.5).
      for (const table of WORKSPACE_TABLES) {
        const clash = await db.query(
          `SELECT 1 FROM ${table} WHERE owner = $1 AND ${anchored} LIMIT 1`,
          [mountOwner(to), `${escapeLike(after)}/%`, after],
        );
        if (clash.rows.length > 0) {
          throw new VendoError(
            "conflict",
            `this app already has files where it would be moved to, so nothing was moved`,
            { appId, path: after },
          );
        }
      }
      let moved = 0;
      for (const table of WORKSPACE_TABLES) {
        // The rewrite replaces exactly the leading `before` root and keeps the
        // rest of the path verbatim, so a path that merely CONTAINS the app id
        // deeper down is untouched — and the root row, whose remainder is the
        // empty string, lands at exactly `after`.
        const result = await db.query(
          `UPDATE ${table}
              SET owner = $4, path = $5 || substring(path FROM ${before.length + 1})
            WHERE owner = $1 AND ${anchored}
            RETURNING 1`,
          [mountOwner(from), subtree, before, mountOwner(to), after],
        );
        if (table === "vendo_workspace_files") moved = result.rows.length;
      }
      return moved;
    },

    async history(owner, path) {
      const result = await db.query(
        `SELECT revision, intent, at FROM vendo_workspace_history
         WHERE path = $1 AND owner = $2 ORDER BY revision DESC`,
        [path, owner],
      );
      return result.rows.map((row) => {
        const intent = row["intent"];
        return {
          revision: Number(row["revision"]),
          ...(typeof intent === "string" ? { intent } : {}),
          at: iso(row["at"]),
        };
      });
    },

  };
}
