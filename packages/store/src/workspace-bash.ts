import { safeErrorMessage, type WorkspaceFs } from "@vendoai/core";
import { normalizePath, USER_MOUNT } from "./workspace-fs.js";

/** What an interpreter hands back for one command. Structural on purpose: this
    module never imports just-bash, so the bash interpreter stays a dependency
    of whoever actually runs it (`@vendoai/harnesses`), not of the store. */
export interface BashRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The bash-visible alias for the scratch directory. Nothing under this path
    ever reaches the store — it is rewritten to `/user/scratch` on the way in. */
const TMP_ALIAS = "/tmp";

/** Intra-turn junk (contract §3.1). Both the shell's cwd and its `/tmp` live
    here, so a relative write and a `/tmp` write land in the same real place. */
const SCRATCH = `${USER_MOUNT}/scratch`;

const aliased = (path: string): string => {
  const normalized = normalizePath(path);
  if (normalized === TMP_ALIAS) return SCRATCH;
  return normalized.startsWith(`${TMP_ALIAS}/`)
    ? `${SCRATCH}/${normalized.slice(TMP_ALIAS.length + 1)}`
    : normalized;
};

const unaliased = (path: string): string =>
  path === SCRATCH ? TMP_ALIAS
    : path.startsWith(`${SCRATCH}/`) ? `${TMP_ALIAS}/${path.slice(SCRATCH.length + 1)}`
      : path;

/**
 * A `WorkspaceFs` that also answers to `/tmp`.
 *
 * The rewrite is bash-level only: every path crosses into the real façade as
 * `/user/scratch/...`, so the store never learns that `/tmp` exists and the
 * frozen layout (§3.1) stays the only thing that persists. `getAllPaths` reports
 * both spellings, because that list is what globbing reads — without the aliases
 * `ls /tmp/*.txt` would find nothing that `cat /tmp/x.txt` can read.
 */
function withTmpAlias(workspace: WorkspaceFs): WorkspaceFs {
  const fs: WorkspaceFs = {
    readFile: (path, options) => workspace.readFile(aliased(path), options),
    readFileBuffer: (path) => workspace.readFileBuffer(aliased(path)),
    writeFile: (path, content, options) => workspace.writeFile(aliased(path), content, options),
    appendFile: (path, content, options) => workspace.appendFile(aliased(path), content, options),
    exists: (path) => workspace.exists(aliased(path)),
    stat: (path) => workspace.stat(aliased(path)),
    lstat: (path) => workspace.lstat(aliased(path)),
    mkdir: (path, options) => workspace.mkdir(aliased(path), options),
    readdir: (path) => workspace.readdir(aliased(path)),
    rm: (path, options) => workspace.rm(aliased(path), options),
    cp: (src, dest, options) => workspace.cp(aliased(src), aliased(dest), options),
    mv: (src, dest) => workspace.mv(aliased(src), aliased(dest)),
    chmod: (path, mode) => workspace.chmod(aliased(path), mode),
    symlink: (target, linkPath) => workspace.symlink(aliased(target), aliased(linkPath)),
    link: (existingPath, newPath) => workspace.link(aliased(existingPath), aliased(newPath)),
    readlink: (path) => workspace.readlink(aliased(path)),
    utimes: (path, atime, mtime) => workspace.utimes(aliased(path), atime, mtime),
    async realpath(path) {
      return unaliased(await workspace.realpath(aliased(path)));
    },
    resolvePath: (base, path) => workspace.resolvePath(aliased(base), path),
    getAllPaths() {
      const paths = workspace.getAllPaths();
      const aliases = paths
        .filter((path) => path === SCRATCH || path.startsWith(`${SCRATCH}/`))
        .map(unaliased);
      return [...new Set([...paths, ...aliases])].sort();
    },
    commit: (opts) => workspace.commit(opts),
    canCommit: (path) => workspace.canCommit(aliased(path)),
  };
  if (workspace.readdirWithFileTypes !== undefined) {
    const readdirWithFileTypes = workspace.readdirWithFileTypes.bind(workspace);
    fs.readdirWithFileTypes = (path) => readdirWithFileTypes(aliased(path));
  }
  return fs;
}

/** POSIX-shaped fs refusals, the ones the façade raises. */
const REFUSAL = /^(EACCES|EROFS|ENOENT|EISDIR|ENOTDIR|ENOTEMPTY|EEXIST|EPERM|EINVAL):/;

export interface WorkspaceBashSetup {
  /** The workspace as the shell sees it: `/tmp` included. Still a `WorkspaceFs`,
      so `commit()` on it lands the turn's real edits. */
  fs: WorkspaceFs;
  /** Inside `/user/scratch`, so a relative write is always legal. */
  cwd: string;
  env: Record<string, string>;
  /** Wrap the interpreter's `exec`. A refused path becomes a failed command —
      nonzero exit, readable stderr — instead of an exception that would abandon
      the turn mid-thought. */
  run(exec: (command: string) => Promise<BashRun>): (command: string) => Promise<BashRun>;
}

/**
 * The canonical in-process bash setup over a workspace (design §8).
 *
 * Defaults matter here: just-bash starts in `/home/user`, which is outside both
 * mounts, so every relative write was refused; and an agent reaching for `/tmp`
 * — which they do constantly — hit a hard refusal for a path the workspace has
 * no opinion about. Pinning the cwd and aliasing `/tmp` into the scratch mount
 * fixes both without giving the store a third top-level path.
 */
export function workspaceBash(
  workspace: WorkspaceFs,
  options: { cwd?: string; env?: Record<string, string> } = {},
): WorkspaceBashSetup {
  const cwd = options.cwd === undefined ? SCRATCH : aliased(options.cwd);
  return {
    fs: withTmpAlias(workspace),
    cwd,
    env: { TMPDIR: TMP_ALIAS, HOME: SCRATCH, PWD: cwd, ...options.env },
    run: (exec) => async (command) => {
      try {
        return await exec(command);
      } catch (error) {
        const message = safeErrorMessage(error);
        // Only the filesystem's own refusals become command failures. Anything
        // else is a real defect and must keep travelling.
        if (!REFUSAL.test(message)) throw error;
        return { exitCode: 1, stdout: "", stderr: `${message}\n` };
      }
    },
  };
}
