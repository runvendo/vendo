import { platform } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface BaseProps {
  vendoVersion: string;
  osPlatform: string;
  nodeVersion: string;
}

export function baseProps(version: string): BaseProps {
  return {
    vendoVersion: version,
    osPlatform: platform(),
    nodeVersion: process.version,
  };
}

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * Fixed public salt prepended to the project identifier before hashing. Not a
 * secret: its only job is making casual rainbow-lookup of well-known repo URLs
 * less trivial. Bump the version suffix to rotate every projectIdHash at once.
 */
export const PROJECT_ID_SALT = "vendo-telemetry-project-v1";

export interface ProjectProps {
  projectIdHash?: string;
  packageManager?: PackageManager;
}

/**
 * Normalize a git remote URL so ssh/https spellings of the same repo hash
 * identically: strip scheme ("https://", "ssh://") and "user@" prefixes,
 * drop an explicit ":PORT", unify the ssh ":" host separator to "/",
 * lowercase, drop trailing ".git". `git@github.com:a/b.git` and
 * `https://github.com/a/b` both become `github.com/a/b`.
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme prefix
  s = s.replace(/^[^/@]+@/, ""); // user@ prefix
  // Explicit port before the path (host:8443/a/b). Must run before the scp
  // rewrite below so an all-digit port isn't kept as a path segment.
  s = s.replace(/^([^/:]+):\d+(?=\/)/, "$1");
  s = s.replace(":", "/"); // ssh host:path separator
  s = s.replace(/\/+$/, "").replace(/\.git$/, "");
  return s;
}

/** Walk up from `startDir` to the repo's git config file, if any. */
function findGitConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const gitPath = join(dir, ".git");
    const stat = statSync(gitPath, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return join(gitPath, "config");
    if (stat?.isFile()) {
      // Worktree/submodule pointer file: "gitdir: <path>".
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitPath, "utf8"))?.[1];
      if (!pointer) return undefined;
      const gitDir = resolve(dir, pointer.trim());
      const commonStat = statSync(join(gitDir, "commondir"), { throwIfNoEntry: false });
      if (commonStat?.isFile()) {
        return join(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()), "config");
      }
      return join(gitDir, "config");
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Extract `[remote "origin"] url` from git config text (line-based ini scan). */
function parseOriginUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line)?.[1];
    if (url) return url.trim();
  }
  return undefined;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(PROJECT_ID_SALT + input).digest("hex");
}

/**
 * Opaque project identifier: salted sha256 of the normalized git origin URL,
 * else of ./package.json's `name`, else undefined (property omitted). Pure
 * synchronous file reads — never spawns git, never throws.
 */
function projectIdHash(cwd: string): string | undefined {
  try {
    const configPath = findGitConfigPath(cwd);
    if (configPath) {
      const url = parseOriginUrl(readFileSync(configPath, "utf8"));
      if (url) return sha256Hex(normalizeRemoteUrl(url));
    }
  } catch {
    // fall through to package.json
  }
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.length > 0) return sha256Hex(pkg.name);
  } catch {
    // no usable source; omit the property
  }
  return undefined;
}

const KNOWN_REPO_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"] as const;
export type RepoHost = (typeof KNOWN_REPO_HOSTS)[number] | "other";

/**
 * Classified git-remote host for the cloud lane's `repoHost` prop: the origin
 * remote's hostname when it is a well-known forge, "other" for any other
 * remote, undefined (key omitted) when no remote exists. Host classification
 * only — never the URL, path, or repo name. Never throws.
 */
export function repoHost(cwd: string = process.cwd()): RepoHost | undefined {
  try {
    const configPath = findGitConfigPath(cwd);
    if (!configPath) return undefined;
    const url = parseOriginUrl(readFileSync(configPath, "utf8"));
    if (!url) return undefined;
    const host = normalizeRemoteUrl(url).split("/")[0] ?? "";
    if (host === "") return undefined;
    return (KNOWN_REPO_HOSTS as readonly string[]).includes(host) ? (host as RepoHost) : "other";
  } catch {
    return undefined;
  }
}

function packageManagerFromUserAgent(userAgent: string | undefined): PackageManager | undefined {
  if (!userAgent) return undefined;
  const name = userAgent.trim().split("/")[0]?.toLowerCase();
  return (PACKAGE_MANAGERS as readonly string[]).includes(name ?? "")
    ? (name as PackageManager)
    : undefined;
}

/**
 * Project-scoped base props. Computed once per telemetry client (not per
 * event) because it reads the filesystem; see createTelemetry. Absent sources
 * omit the key entirely rather than sending a placeholder.
 */
export function projectProps(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ProjectProps {
  const out: ProjectProps = {};
  const hash = projectIdHash(cwd);
  if (hash) out.projectIdHash = hash;
  const pm = packageManagerFromUserAgent(env.npm_config_user_agent);
  if (pm) out.packageManager = pm;
  return out;
}
