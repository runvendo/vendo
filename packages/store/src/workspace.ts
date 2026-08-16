import type { FilesAdapter, Membership, Principal, RunContext, WorkspaceFs } from "@vendoai/core";
import { storeFiles } from "./files-store.js";
import { appAccess, appOfOrgPath, orgOfPath } from "./helpers/app-access.js";
import { backendOf } from "./helpers/backend.js";
import type { VendoStore } from "./store.js";
import { workspaceOpsRows } from "./workspace-ops-rows.js";
import { HOST_MOUNT, normalizePath, pathNotFound, WorkspaceStoreFs } from "./workspace-fs.js";
import { workspaceRows, type AppMount, type WorkspaceFileMeta, type WorkspaceHistoryEntry } from "./workspace-rows.js";

/** Build contract §9.7 — what the façade needs to know about the caller: who
    they are, and which orgs the host ASSERTED this request. A RunContext
    satisfies it, which is what every caller actually has. */
export type WorkspaceCaller = Pick<RunContext, "principal"> & { memberships?: Membership[] };

/** One file a caller can see, and whether they may write it (build contract
    §3.5 — checkout materializes the visible set, editor-level mounts rw). */
export interface VisibleWorkspaceFile {
  path: string;
  owner: string;
  revision: number;
  writable: boolean;
}

/** What the caller projects into the read-only `/host` mount for one turn:
    path → contents. Paths outside `/host/` are refused, because the layout is
    product (contract §3.1) and this is the only door into it. */
export type HostProjection = Record<string, string | Uint8Array>;

const encoder = new TextEncoder();

function hostFiles(projection: HostProjection | undefined): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(projection ?? {})) {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${HOST_MOUNT}/`)) {
      throw new Error(`Host projection paths live under ${HOST_MOUNT}/ — got '${path}'`);
    }
    files.set(normalized, typeof content === "string" ? encoder.encode(content) : content);
  }
  return files;
}

/**
 * Build contract §3 — the workspace: the agent's filesystem as a façade over
 * the store. `open` is called once per turn (it builds the path index just-bash
 * needs synchronously); `history` reads the same rows the façade writes, so
 * what the user sees in the trail is exactly what the agent did.
 */
export function workspaceStore(store: VendoStore, options: { files?: FilesAdapter } = {}): {
  /** One workspace, one turn. Writes stage until `commit()`. `host` projects
      the read-only mount (skills, host knowledge) for this turn. */
  open(
    principal: Principal,
    opts?: {
      host?: HostProjection;
      /** Build contract §9.7 — one `/orgs/<org>` mount per ASSERTED membership.
          Absent ⇒ no org mounts at all, exactly today's single-player façade. */
      memberships?: Membership[];
      /** This caller's whole path index, already read (`turn.load` reads it
          beside the thread). Covers EVERY owner in `memberships` or none —
          a partial index would open a turn whose workspace is missing files.
          Absent ⇒ read here, exactly as every caller always did. */
      index?: WorkspaceFileMeta[];
    },
  ): Promise<WorkspaceFs>;
  /** Newest superseded revision first; viewer-level, like any other read. */
  history(caller: WorkspaceCaller, path: string): Promise<WorkspaceHistoryEntry[]>;
  /** Build contract §9.5 — promote's workspace half; see WorkspaceRows.moveApp. */
  moveApp(appId: string, from: AppMount, to: AppMount): Promise<number>;
  /** Build contract §3.5 / §9.3 — checkout's query: every file this caller
      reaches, and whether each is writable. Wave-2's sandbox lane materializes
      from this; nothing here writes to a disk (that is lane E's). */
  visibleFiles(caller: WorkspaceCaller): Promise<VisibleWorkspaceFile[]>;
  /** Sync-back's per-path check, against LIVE rows — the second of the two
      moments `can()` runs for a sandboxed harness. A mid-session revoke bites
      here even though the reads it already served stand. */
  canCommit(caller: WorkspaceCaller, path: string): Promise<boolean>;
} {
  // T1/D1 — the branch is INSIDE the helper: a store with its own Postgres
  // keeps today's row helpers, a store with only the 32-op contract (the hosted
  // one: a key, no database) rides the same façade over the wire. Nothing above
  // this line can tell the two apart, which is what lets a hosted deployment
  // serve harness turns with zero caller changes. The permission checks below
  // are untouched — `can()` reads through the records door, which the hosted
  // store already serves.
  const backend = backendOf(store, "the workspace");
  const rows = backend.kind === "sql"
    ? workspaceRows(backend.db, options.files ?? storeFiles(store))
    : workspaceOpsRows(backend.ops);
  const access = appAccess(store);

  /** The ctx `can()` reads: it only ever looks at the subject and the asserted
      memberships, so the rest is filler the type asks for. */
  const runContextOf = (caller: WorkspaceCaller): RunContext => ({
    principal: caller.principal,
    venue: "app",
    presence: "present",
    sessionId: "",
    ...(caller.memberships === undefined ? {} : { memberships: caller.memberships }),
  });

  const canRead = async (caller: WorkspaceCaller, path: string): Promise<boolean> =>
    await access.can(runContextOf(caller), "viewer", { path });

  const canWrite = async (caller: WorkspaceCaller, path: string): Promise<boolean> =>
    await access.can(runContextOf(caller), "editor", { path });

  /** Build contract §9.7 — owner derivation is a PURE FUNCTION OF THE PATH, in
      every door and not just the façade: the org for `/orgs/<org>/**`, the
      bound subject for `/user/**`. Deriving it from the principal instead made
      a promoted app's history unreachable. Guarded by `can()` at every caller,
      so a path in an unasserted org is refused before it is ever addressed. */
  const ownerOfPath = (caller: WorkspaceCaller, path: string): string =>
    orgOfPath(path) ?? caller.principal.subject;

  /** Every owner one caller's façade reads through: themselves, plus each org
      the host asserted. An org absent from the assertions has no owner here. */
  const ownersOf = (caller: WorkspaceCaller): string[] =>
    [caller.principal.subject, ...(caller.memberships ?? []).map((membership) => membership.org)];

  /** `ls` on a mount is a QUERY, not a directory read (design §8): the index a
      turn opens with is already narrowed to what this caller may see, so an org
      app they hold no grant on is simply absent rather than forbidden. */
  const visibleIndex = async (
    caller: WorkspaceCaller,
    /** The same rows `rows.index` would have answered, read by the caller in
        the same breath as the rest of the turn (`turn.load`). It skips the
        READ, never the permission filter below — a prefetched index is still
        narrowed to what this caller may see. */
    prefetched?: WorkspaceFileMeta[],
  ): Promise<Awaited<ReturnType<typeof rows.index>>> => {
    const all = prefetched ?? await rows.index(ownersOf(caller));
    // Every file under `/orgs/<org>/apps/<appId>/` shares that app's own grant
    // decision (§9.3), and `can()` pays store reads per app — so resolve each
    // app once, every check in flight together. Serial per-file checks were
    // most of a shared workspace's open cost, on every single turn.
    const byApp = new Map<string, Promise<boolean>>();
    const readable = await Promise.all(all.map((meta) => {
      if (meta.owner === caller.principal.subject) return true;
      const app = appOfOrgPath(meta.path);
      if (app === undefined) return canRead(caller, meta.path);
      let decision = byApp.get(app);
      if (decision === undefined) {
        decision = canRead(caller, meta.path);
        byApp.set(app, decision);
      }
      return decision;
    }));
    return all.filter((_, index) => readable[index] === true);
  };

  return {
    async open(principal, opts) {
      const caller: WorkspaceCaller = {
        principal,
        ...(opts?.memberships === undefined ? {} : { memberships: opts.memberships }),
      };
      const index = await visibleIndex(caller, opts?.index);
      return new WorkspaceStoreFs(
        rows,
        {
          subject: principal.subject,
          orgs: (opts?.memberships ?? []).map((membership) => membership.org),
          canCommit: (path) => canWrite(caller, path),
          canView: (path) => canRead(caller, path),
        },
        index,
        hostFiles(opts?.host),
      );
    },
    async history(caller, path) {
      const normalized = normalizePath(path);
      if (!(await canRead(caller, normalized))) {
        // The failing predicate IS the viewer check, so this is never
        // `forbidden`: a caller who cannot even read is not told the path is
        // there (§9.4).
        throw pathNotFound(normalized);
      }
      return await rows.history(ownerOfPath(caller, normalized), normalized);
    },
    async moveApp(appId, from, to) {
      return await rows.moveApp(appId, from, to);
    },
    async visibleFiles(caller) {
      const visible: VisibleWorkspaceFile[] = [];
      for (const meta of await visibleIndex(caller)) {
        visible.push({
          path: meta.path,
          owner: meta.owner,
          revision: meta.revision,
          writable: await canWrite(caller, meta.path),
        });
      }
      return visible;
    },
    async canCommit(caller, path) {
      return await canWrite(caller, normalizePath(path));
    },
  };
}

export { HOST_MOUNT, ORGS_MOUNT, USER_MOUNT } from "./workspace-fs.js";
export {
  WORKSPACE_HISTORY_LIMIT,
  WORKSPACE_INLINE_MAX_BYTES,
  type AppMount,
  type WorkspaceFileMeta,
  type WorkspaceHistoryEntry,
} from "./workspace-rows.js";
