// The filesystem shape lives in core (vendored from just-bash, Apache-2.0), so
// neither core nor the store depends on the bash interpreter at runtime.
import {
  type BufferEncoding,
  type CommitResult,
  type CpOptions,
  type DirentEntry,
  type FileContent,
  type FsStat,
  type MkdirOptions,
  type ReadFileOptions,
  type RmOptions,
  safeErrorMessage,
  VendoError,
  type WorkspaceFs,
  type WriteFileOptions,
} from "@vendoai/core";
import type { PreparedWrite, WorkspaceFileMeta, WorkspaceRows } from "./workspace-rows.js";

/** Build contract §3.1 — the frozen layout. `/user` is the subject's, rw;
    `/orgs/<orgId>` is one mount per ASSERTED membership (§9.7), owned by the
    org; `/host` is host-authored, ro for everyone. No other top-level mount
    exists, and no path's meaning depends on who wrote it. */
export const USER_MOUNT = "/user";
export const HOST_MOUNT = "/host";
export const ORGS_MOUNT = "/orgs";

/** Intra-turn junk (§3.1): visible to the turn, never committed to the store.
    One per mount — `/user/scratch` and `/orgs/<org>/scratch` — because a turn
    working in an org mount has the same throwaway files a personal turn does,
    and committing them would publish them to the whole team. The bare path
    counts: a FILE called `scratch` would otherwise persist and shadow the
    directory the layout reserves. */
const SCRATCH = /^(?:\/user|\/orgs\/[^/]+)\/scratch(?:\/|$)/;

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

/** POSIX-shaped errors, matching the messages just-bash's own filesystems
    throw — bash prints them verbatim, so the wording is user-visible. */
const enoent = (op: string, path: string): Error =>
  new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
const erofs = (op: string, path: string): Error =>
  new Error(`EROFS: read-only file system, ${op} '${path}'`);
const eisdir = (op: string, path: string): Error =>
  new Error(`EISDIR: illegal operation on a directory, ${op} '${path}'`);
const enotdir = (op: string, path: string): Error =>
  new Error(`ENOTDIR: not a directory, ${op} '${path}'`);
const enotempty = (op: string, path: string): Error =>
  new Error(`ENOTEMPTY: directory not empty, ${op} '${path}'`);
const eexist = (op: string, path: string): Error =>
  new Error(`EEXIST: file already exists, ${op} '${path}'`);
/** The workspace is exactly the mounts §3.1 names. A write anywhere else is a
    mistake — `/User/apps/...`, `/user/../x`, `/etc/passwd`, or an org the host
    did not assert this request — and silently accepting it would lose the data
    at commit with an `ok` status. The message names the mounts THIS caller
    actually has, because "no such org" and "no orgs at all" are different
    problems with different fixes. */
const eacces = (op: string, path: string, mounts: readonly string[]): Error =>
  new Error(
    `EACCES: permission denied, ${op} '${path}'`
      + ` (the workspace holds ${mounts.join(", ")})`,
  );

/** Resolve `.`/`..`, collapse slashes, drop the trailing one. Pure. */
export function normalizePath(path: string): string {
  if (path.includes("\u0000")) throw new Error(`ENOENT: path contains null byte, '${path}'`);
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

const dirnameOf = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
};

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** A file staged in memory this turn. Reads see it before the store does. */
interface Staged {
  bytes: Uint8Array;
  mtime: Date;
}

const encoder = new TextEncoder();

const toBytes = (content: FileContent, options?: WriteFileOptions | BufferEncoding): Uint8Array => {
  if (typeof content !== "string") return content;
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
    return encoder.encode(content);
  }
  return new Uint8Array(Buffer.from(content, encoding));
};

const fromBytes = (bytes: Uint8Array, options?: ReadFileOptions | BufferEncoding): string => {
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (encoding === undefined || encoding === null || encoding === "utf8" || encoding === "utf-8") {
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(bytes).toString(encoding);
};

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const statOf = (kind: "file" | "directory", size: number, mtime: Date): FsStat => ({
  isFile: kind === "file",
  isDirectory: kind === "directory",
  isSymbolicLink: false,
  mode: kind === "file" ? FILE_MODE : DIR_MODE,
  size,
  mtime,
});

/**
 * Build contract §3.2 — just-bash's `IFileSystem` over the store.
 *
 * Two tiers, one namespace:
 *   - a **path index** built at turn start (`getAllPaths`/`resolvePath` are
 *     synchronous in just-bash, so the paths must be known without I/O), kept
 *     current on every write;
 *   - **content read through the store**, never cached — except for paths this
 *     turn has written, which stage in memory until `commit()`.
 *
 * Staging is what keeps the store write law at O(files changed): a `sed -i`
 * loop writing one file forty times is one row, one revision, one history
 * entry.
 *
 * The namespace is exactly the mounts the host asserted: `/user`, plus one
 * `/orgs/<org>` per asserted membership. A write anywhere else is refused
 * (`EACCES`) rather than accepted into memory and dropped at commit — bash's
 * own scratch belongs in the `scratch` directory each mount reserves for it.
 *
 * `/host/**` is a read-only overlay the caller supplies per turn, not store
 * rows: skills and host knowledge are code-defined (`Skill.body`,
 * contract §5), so projecting them per turn is always current, while a copy in
 * the store could go stale against the deployed code.
 */
/** Build contract §9.7 — what one turn's façade may reach. `subject` owns
    `/user/**`; each asserted org owns `/orgs/<org>/**`. `canCommit` is the
    per-path live-rows check the commit runs (§9.3's path variant); absent, the
    façade is single-player and every `/user` write lands as it always did. */
export interface WorkspaceMounts {
  subject: string;
  /** Org ids the host ASSERTED this request. An org that is not here has no
      mount at all — not an empty one, not a forbidden one: absent. */
  orgs: readonly string[];
  /** Live-rows `can(editor)` for one path. Runs at commit, never at read: the
      box is a snapshot, so reads age gracefully and writes never sneak through. */
  canCommit?: (path: string) => Promise<boolean>;
  /** Live-rows `can(viewer)` for one path — consulted ONLY to choose the code a
      refused commit wears (§9.4): `forbidden` for a caller who provably sees the
      path, the masked `not-found` for everyone else. Absent ⇒ every refusal is
      `forbidden`, which is correct for a single-player façade where the only
      reachable paths are the caller's own. */
  canView?: (path: string) => Promise<boolean>;
}

/** Build contract §9.4 — what a caller who cannot even VIEW a path is told:
    exactly what a path that isn't there is told. Existence-masking is the
    default posture, and a `forbidden` handed to a non-viewer inverts it into an
    oracle ("this org has an app by that id"). Both doors that refuse a path —
    the façade and the staged-commit gate below — say it in these words, from
    here, because two copies of a refusal are two refusals that drift. */
export const pathNotFound = (path: string): VendoError =>
  new VendoError("not-found", `no such path: ${path}`, { path });

/** §9.4's other half: a caller who provably SEES the path but may not change it
    gets `forbidden` — the code the consumer-voice fork offer renders from.
    Keeping "forbidden implies caller is >= viewer" true is what makes that offer
    safe to show. */
export const pathForbidden = (path: string): VendoError =>
  new VendoError("forbidden", `you cannot write ${path}`, { path });

export class WorkspaceStoreFs implements WorkspaceFs {
  private readonly staged = new Map<string, Staged>();
  private readonly removed = new Set<string>();
  private readonly directories = new Set<string>();
  private readonly index: Map<string, WorkspaceFileMeta>;

  constructor(
    private readonly rows: WorkspaceRows,
    private readonly mounts: WorkspaceMounts,
    index: WorkspaceFileMeta[],
    private readonly host: Map<string, Uint8Array>,
  ) {
    this.index = new Map(index.map((meta) => [meta.path, meta]));
  }

  /** Build contract §9.7 — owner derivation is a PURE FUNCTION OF THE PATH:
      `/user/**` is the bound subject's, `/orgs/<org>/**` is the org's. An org
      the host did not assert has no owner here, so it has no mount. */
  private ownerOf(path: string): string | undefined {
    if (under(path, USER_MOUNT)) return this.mounts.subject;
    const org = /^\/orgs\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    return org !== undefined && this.mounts.orgs.includes(org) ? org : undefined;
  }

  /** The mount roots this caller has, in the order readdir reports them. */
  private mountNames(): string[] {
    return ["host", ...(this.mounts.orgs.length > 0 ? ["orgs"] : []), "user"];
  }

  private storeBacked(path: string): boolean {
    return this.ownerOf(path) !== undefined;
  }

  private readOnly(path: string): boolean {
    return under(path, HOST_MOUNT);
  }

  /** Every write goes through here: `/host` is read-only, and anything outside
      this caller's mounts is refused outright rather than accepted and dropped. */
  private assertWritable(op: string, path: string): void {
    if (this.readOnly(path)) throw erofs(op, path);
    if (!this.storeBacked(path)) {
      throw eacces(op, path, this.mountNames().map((name) => `/${name}`));
    }
    // A file cannot also be a directory. Allowing it produced a name that
    // readdir reported twice — once as each — and bash globs processed twice.
    for (let parent = dirnameOf(path); parent !== "/"; parent = dirnameOf(parent)) {
      if (this.isFile(parent)) throw enotdir(op, path);
    }
  }

  private persists(path: string): boolean {
    return this.storeBacked(path) && !SCRATCH.test(path);
  }

  /** Every path the turn can see: the store's index, the host overlay, and this
      turn's writes. */
  private livePaths(): string[] {
    const paths = new Set<string>();
    for (const path of this.index.keys()) if (!this.removed.has(path)) paths.add(path);
    for (const path of this.host.keys()) paths.add(path);
    for (const path of this.staged.keys()) paths.add(path);
    return [...paths];
  }

  private isFile(path: string): boolean {
    if (this.staged.has(path) || this.host.has(path)) return true;
    return this.index.has(path) && !this.removed.has(path);
  }

  /** Directories are implied by the paths under them (the store holds files,
      not directories), plus anything explicitly `mkdir`ed this turn. */
  private isDirectory(path: string): boolean {
    if (path === "/" || path === USER_MOUNT || path === HOST_MOUNT) return true;
    // A mounted org is a directory even while empty — the mount is what the
    // membership grants, whether or not anyone has written in it yet.
    if (this.mounts.orgs.length > 0 && path === ORGS_MOUNT) return true;
    if (this.mounts.orgs.some((org) => path === `${ORGS_MOUNT}/${org}`)) return true;
    if (this.directories.has(path)) return true;
    return this.livePaths().some((candidate) => candidate.startsWith(`${path}/`));
  }

  private async bytesOf(op: string, path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const staged = this.staged.get(normalized);
    if (staged) return staged.bytes;
    const hosted = this.host.get(normalized);
    if (hosted) return hosted;
    if (this.isDirectory(normalized) && !this.isFile(normalized)) throw eisdir(op, path);
    if (!this.storeBacked(normalized) || this.removed.has(normalized) || !this.index.has(normalized)) {
      throw enoent(op, path);
    }
    const bytes = await this.rows.read(this.ownerOf(normalized)!, normalized);
    if (bytes === undefined) throw enoent(op, path);
    return bytes;
  }

  private stage(path: string, bytes: Uint8Array): void {
    this.staged.set(path, { bytes, mtime: new Date() });
    this.removed.delete(path);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return fromBytes(await this.bytesOf("open", path), options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return await this.bytesOf("open", path);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("open", normalized);
    if (this.isDirectory(normalized) && !this.isFile(normalized)) throw eisdir("open", path);
    this.stage(normalized, toBytes(content, options));
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("open", normalized);
    const existing = (await this.exists(normalized)) ? await this.bytesOf("open", normalized) : new Uint8Array();
    this.stage(normalized, concat(existing, toBytes(content, options)));
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    return this.isFile(normalized) || this.isDirectory(normalized);
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    const staged = this.staged.get(normalized);
    if (staged) return statOf("file", staged.bytes.byteLength, staged.mtime);
    const hosted = this.host.get(normalized);
    // Host files come from the deployment, not the store, so they carry no
    // per-file timestamp — the epoch is the honest answer.
    if (hosted) return statOf("file", hosted.byteLength, new Date(0));
    // Served from the turn-start index on purpose: the workspace a turn sees is
    // a SNAPSHOT (§8's "the box is a snapshot"). A file another session changed
    // mid-turn keeps its opening size and mtime here, exactly like a Docs revoke
    // that does not un-render what is already on screen — reads age gracefully,
    // and `commit()` is where staleness actually bites (its compare-and-swap).
    const meta = this.removed.has(normalized) ? undefined : this.index.get(normalized);
    if (meta) return statOf("file", meta.bytes, new Date(meta.updatedAt));
    if (this.isDirectory(normalized)) return statOf("directory", 0, new Date(0));
    throw enoent("stat", path);
  }

  /** No symlinks over a document store, so lstat is stat. */
  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("mkdir", normalized);
    if (this.isFile(normalized)) throw eexist("mkdir", path);
    if (this.isDirectory(normalized)) {
      if (options?.recursive === true) return;
      throw eexist("mkdir", path);
    }
    if (options?.recursive !== true && !this.isDirectory(dirnameOf(normalized))) {
      throw enoent("mkdir", path);
    }
    this.directories.add(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = normalizePath(path);
    if (this.isFile(normalized)) throw enotdir("scandir", path);
    if (!this.isDirectory(normalized)) throw enoent("scandir", path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const files = new Set<string>();
    const directories = new Set<string>();
    const collect = (candidate: string, kind: "file" | "directory"): void => {
      if (!candidate.startsWith(prefix) || candidate === normalized) return;
      const rest = candidate.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (rest === "") return;
      // A deeper segment always means a directory, whatever the leaf is.
      if (cut === -1) (kind === "file" ? files : directories).add(rest);
      else directories.add(rest.slice(0, cut));
    };
    for (const candidate of this.livePaths()) collect(candidate, "file");
    // An explicitly mkdir'ed path is a directory even with nothing under it —
    // reporting it as a file made `find -type f` return directories.
    for (const candidate of this.directories) collect(candidate, "directory");
    if (normalized === "/") {
      for (const name of this.mountNames()) directories.add(name);
    }
    // `ls /orgs` is a query over the assertions, not a directory read (design
    // §8): every asserted org appears, empty or not.
    if (normalized === ORGS_MOUNT) for (const org of this.mounts.orgs) directories.add(org);
    // One entry per name, whatever the two sets say: a name is a directory if
    // anything lives under it, otherwise a file.
    return [...new Set([...directories, ...files])]
      .map((name) => ({
        name,
        isFile: !directories.has(name),
        isDirectory: directories.has(name),
        isSymbolicLink: false,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (this.readOnly(normalized)) throw erofs("rm", path);
    if (this.isFile(normalized)) {
      this.drop(normalized);
      return;
    }
    if (this.isDirectory(normalized)) {
      const children = this.livePaths().filter((candidate) => candidate.startsWith(`${normalized}/`));
      if (options?.recursive !== true && children.length > 0) throw enotempty("rm", path);
      for (const child of children) this.drop(child);
      for (const directory of [...this.directories]) {
        if (under(directory, normalized)) this.directories.delete(directory);
      }
      return;
    }
    if (options?.force !== true) throw enoent("rm", path);
  }

  private drop(path: string): void {
    this.staged.delete(path);
    if (this.index.has(path)) this.removed.add(path);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const from = normalizePath(src);
    const to = normalizePath(dest);
    this.assertWritable("copyfile", to);
    if (this.isFile(from)) {
      this.stage(to, await this.bytesOf("copyfile", from));
      return;
    }
    if (!this.isDirectory(from)) throw enoent("copyfile", src);
    if (options?.recursive !== true) throw eisdir("cp", src);
    for (const child of this.livePaths().filter((candidate) => candidate.startsWith(`${from}/`))) {
      this.stage(`${to}${child.slice(from.length)}`, await this.bytesOf("copyfile", child));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = normalizePath(src);
    this.assertWritable("rename", from);
    await this.cp(src, dest, { recursive: true });
    await this.rm(from, { recursive: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${base}/${path}`);
  }

  getAllPaths(): string[] {
    const paths = new Set(this.livePaths());
    for (const directory of this.directories) paths.add(directory);
    return [...paths].sort();
  }

  async chmod(path: string, _mode: number): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("chmod", normalized);
    if (!(await this.exists(normalized))) throw enoent("chmod", path);
    // Modes are not part of the workspace: the store holds documents, and the
    // only permission that exists is the mount's (wave-1 `can()`).
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, link '${newPath}'`);
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!(await this.exists(normalized))) throw enoent("realpath", path);
    return normalized;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("utimes", normalized);
    const bytes = await this.bytesOf("utimes", normalized);
    this.staged.set(normalized, { bytes, mtime });
  }

  /**
   * Build contract §9.3, exposed — the same live-rows question `commit()` asks
   * itself below, asked one path at a time.
   *
   * The sandbox path (§3.5) needs it out loud: it holds a workspace and never a
   * store, and it has to know per FILE whether a checkout lands writable and
   * whether a changed file may go home. Answering from the mount shape instead
   * is what made every `/orgs/**` path invisible to `claudeCode()`.
   */
  async canCommit(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.readOnly(normalized) || !this.storeBacked(normalized)) return false;
    // Absent ⇒ single-player façade, where the only reachable mount is the
    // caller's own `/user` — exactly the answer `commit()` gives itself.
    return this.mounts.canCommit === undefined || await this.mounts.canCommit(normalized);
  }

  /**
   * Build contract §3.2 — land the turn's writes. Commit policy is per mount:
   * `/user` is last-write-wins, `/orgs` is strict compare-and-swap against the
   * revision the turn opened with, and a lost swap returns `conflict`.
   *
   * **Preflighted.** Every staged file's content is placed first; only when the
   * whole set is placeable does any row change. A commit therefore either lands
   * all of it or lands none of it — an oversized upload can no longer swallow
   * the same turn's app edit just by being staged first. Deterministic failures
   * (over the store-backed cap, an adapter refusal) throw a `VendoError` naming
   * the file; `CommitResult` keeps its frozen `ok | conflict` vocabulary.
   *
   * Only paths whose bytes actually changed are written (§3.5), so `changed` is
   * the honest O(files changed) count. `/user/scratch/**` never lands.
   */
  async commit(opts?: { message?: string }): Promise<CommitResult> {
    // Build contract §8/§9.3 — the box is born filtered, so `can()` runs at
    // exactly two moments; this is the second. Live rows, per changed path,
    // BEFORE anything is placed: a mid-session revoke must bite here even
    // though the reads it already served stand.
    if (this.mounts.canCommit !== undefined) {
      for (const path of [...this.staged.keys(), ...this.removed]) {
        if (!this.persists(path)) continue;
        if (!(await this.mounts.canCommit(path))) {
          // §9.4 — `forbidden` says "you can see this, but not change it", and
          // the fork offer renders off exactly that. A caller who cannot even
          // view the path gets what a path that isn't there gets, or the code
          // itself becomes an existence oracle for every org app id.
          if (this.mounts.canView !== undefined && !(await this.mounts.canView(path))) {
            throw pathNotFound(path);
          }
          throw pathForbidden(path);
        }
      }
    }
    const landing: PreparedWrite[] = [];
    for (const [path, staged] of this.staged) {
      if (!this.persists(path)) continue;
      let prepared: PreparedWrite | "unchanged";
      try {
        prepared = await this.rows.prepare(this.ownerOf(path)!, path, staged.bytes);
      } catch (cause) {
        // Nothing has been written yet; release what this commit already placed
        // so a rejected commit leaves no orphaned content behind. Best-effort:
        // a bucket that refuses DeleteObject must not replace the diagnosis of
        // WHY the commit failed, nor stop the remaining releases.
        const cleanupFailures: string[] = [];
        for (const done of landing) {
          try {
            await this.rows.discard(done);
          } catch (failure) {
            cleanupFailures.push(`${done.path}: ${safeErrorMessage(failure)}`);
          }
        }
        // The adapter already said what kind of failure this is (refused, absent,
        // throttled); re-labelling it all `validation` told callers to go fix an
        // argument that was already correct.
        const code = cause instanceof VendoError ? cause.code : "validation";
        throw new VendoError(
          code,
          `Cannot commit ${path}: ${safeErrorMessage(cause)}`,
          { path, ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}) },
        );
      }
      if (prepared !== "unchanged") landing.push(prepared);
    }

    const changed: string[] = [];
    const conflicts: string[] = [];
    for (const path of [...this.removed].filter((candidate) => this.persists(candidate))) {
      if (await this.rows.remove(this.ownerOf(path)!, path, opts?.message)) {
        this.index.delete(path);
        changed.push(path);
      }
    }
    this.removed.clear();
    for (const prepared of landing) {
      // Build contract §9.7 — commit policy is PER MOUNT: `/user` keeps the
      // last-write-wins re-aim loop, `/orgs` is strict compare-and-swap, so a
      // lost swap comes back as `conflict` for the harness to re-read and
      // re-apply rather than silently overwriting a colleague.
      const owner = this.ownerOf(prepared.path)!;
      const strict = !under(prepared.path, USER_MOUNT);
      const written = await this.rows.land(owner, prepared, opts?.message, {
        strict,
        // The revision this TURN opened with (§3.5's checkout base), not the
        // head at commit time — the whole point of CAS is to notice the edit
        // that landed in between.
        expectedRevision: this.index.get(prepared.path)?.revision ?? null,
      });
      if (written.conflict === true) {
        conflicts.push(prepared.path);
        continue;
      }
      this.index.set(prepared.path, {
        path: prepared.path,
        owner,
        bytes: prepared.bytes,
        revision: written.revision,
        updatedAt: written.updatedAt,
      });
      // A concurrent commit may have already stored these exact bytes, in which
      // case this commit wrote nothing and must not claim the file changed.
      if (written.landed) changed.push(prepared.path);
    }
    if (conflicts.length > 0) return { status: "conflict", paths: conflicts.sort() };
    // Committed files now read through the store like everything else.
    for (const path of changed) this.staged.delete(path);
    return { status: "ok", changed: changed.sort() };
  }
}
