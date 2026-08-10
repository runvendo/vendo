import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAppRoot } from "./app-root.js";
import { normalizeBootstrapInstallCommand } from "./install-command.js";
import { pnpmDeclaresBuiltDependencies } from "./pnpm-build-policy.js";
import type { ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";
import { ENGINE_STRICT_OFF_ENV, runCommand } from "./process.js";
import { pathExists } from "./util.js";

export type BootstrapRepo = Pick<ManifestEntry, "name" | "appDir" | "localPath" | "bootstrap">;

export interface BootstrapOptions {
  context?: CorpusRunContext;
  env?: NodeJS.ProcessEnv;
  /** Backoff before the one bootstrap retry (transient failures only).
      Tests pass 0 to keep the suite fast. */
  retryDelayMs?: number;
}

export interface BootstrapLogPaths {
  stdout: string;
  stderr: string;
}

export interface BootstrapResult {
  repoDir: string;
  envPath: string;
  logs: BootstrapLogPaths;
}

const placeholderPattern = /\$\{(CORPUS_[A-Z0-9_]+)\}/g;

function resolveEnvTemplate(
  envTemplate: Record<string, string>,
  env: NodeJS.ProcessEnv,
): { values: Record<string, string>; missing: string[] } {
  const missing = new Set<string>();
  const values: Record<string, string> = {};

  for (const [key, template] of Object.entries(envTemplate)) {
    values[key] = template.replace(placeholderPattern, (match, variable: string) => {
      const value = env[variable];
      if (value === undefined) {
        missing.add(variable);
        return match;
      }
      return value;
    });
  }

  return {
    values,
    missing: [...missing].sort(),
  };
}

function formatEnv(values: Record<string, string>): string {
  const lines = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function logPaths(logsDir: string): BootstrapLogPaths {
  return {
    stdout: path.join(logsDir, "bootstrap.stdout.log"),
    stderr: path.join(logsDir, "bootstrap.stderr.log"),
  };
}

const DEFAULT_RETRY_DELAY_MS = 5_000;

// Small, deliberately narrow transient-failure class. Real dependency/config
// errors are NOT in this list on purpose — only failures that look like
// registry/resolver hiccups get the one bounded retry. Resolution errors
// (ERR_PNPM_NO_MATCHING_VERSION) are deliberately excluded: they are
// deterministic, and retrying them only hides the regression that caused them.
const TRANSIENT_BOOTSTRAP_FAILURE_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /\bE5\d{2}\b/, // npm/pnpm registry 5xx error codes (E500, E502, E503, ...)
  /\b5\d{2}\b.*registry/i, // "... 500 ... registry ..." style transport errors
];

function isTransientBootstrapFailure(output: string): boolean {
  return TRANSIENT_BOOTSTRAP_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

/** The env vars above cover every pnpm that reads its config from the
 * environment, but not the one invocation that matters most: a repo script like
 * rallly's `db:generate` shells out to `pnpm --filter … exec`, and on that path
 * pnpm 10 re-runs the engines check reading only the project's own .npmrc — no
 * env var and no CLI flag reaches it, because the command lives inside the
 * repo's package.json, not in anything the harness passes. A pinned checkout's
 * `engines.node` is about the day it was pinned, so neutralize the guard at its
 * source. Rewrites in place rather than appending: npm's ini parser keeps the
 * FIRST occurrence of a key, so a trailing `engine-strict=false` does nothing
 * (measured on rallly under pnpm 10.28 / Node 26). */
async function relaxEngineStrict(repoDir: string): Promise<boolean> {
  const npmrc = path.join(repoDir, ".npmrc");
  const source = await readFile(npmrc, "utf8").catch(() => null);
  if (source === null) return false;
  const relaxed = source.replace(/^[ \t]*engine-strict[ \t]*=.*$/gim, "engine-strict=false");
  if (relaxed === source) return false;
  await writeFile(npmrc, relaxed);
  return true;
}

export async function bootstrapRepo(repo: BootstrapRepo, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const context = options.context ?? createRunContext();
  const env = { ...process.env, ...options.env };
  const repoDir = context.repoDir(repo.name);
  const appRoot = resolveAppRoot(repo, repoDir);
  const logsDir = context.logsDir(repo.name);
  const logs = logPaths(logsDir);

  const resolved = resolveEnvTemplate(repo.bootstrap.envTemplate, env);
  if (resolved.missing.length > 0) {
    throw new Error(`Missing bootstrap environment variables for ${repo.name}: ${resolved.missing.join(", ")}`);
  }

  const envPath = path.join(appRoot, ".env");
  await writeFile(envPath, formatEnv(resolved.values));

  await mkdir(logsDir, { recursive: true });
  if (repo.localPath !== undefined) {
    await writeFile(logs.stdout, "Skipped pre-injection install for local corpus source; injection performs the standalone install.\n");
    await writeFile(logs.stderr, "");
    return {
      repoDir,
      envPath,
      logs,
    };
  }

  const hasPnpmWorkspace = await pathExists(path.join(repoDir, "pnpm-workspace.yaml"));
  // pnpm ≥10 rejects dangerouslyAllowAllBuilds when the repo already curates
  // its own build allowlist (onlyBuiltDependencies/neverBuiltDependencies) —
  // respect the repo's explicit config instead of forcing the blanket flag.
  const repoCuratesBuilds = await pnpmDeclaresBuiltDependencies(repoDir);
  const installCommand = normalizeBootstrapInstallCommand(repo.bootstrap.installCommand, {
    dropIgnoreWorkspace: hasPnpmWorkspace,
    pnpmConfig: repoCuratesBuilds ? ["--config.minimumReleaseAge=0"] : undefined,
  });
  // Once, before the install, so every later host command — typecheck, build,
  // and the nested pnpm calls inside the repo's own scripts — runs against a
  // relaxed checkout too.
  const engineNote = await relaxEngineStrict(repoDir)
    ? `Corpus harness set engine-strict=false in ${repo.name}'s .npmrc so the pinned checkout's engines.node cannot fail this host's Node.\n`
    : "";
  // Only the engine guard is relaxed here: the build-script and lockfile
  // guards ride the normalized CLI flags above, which respect a repo that
  // curates its own build allowlist.
  const installEnv = { ...env, ...ENGINE_STRICT_OFF_ENV };
  let result = await runCommand(installCommand.command, { cwd: repoDir, env: installEnv });
  const normalizationNote = installCommand.changed
    ? `Corpus harness normalized bootstrap install command from "${repo.bootstrap.installCommand}" to "${installCommand.command}" so lockfile updates are allowed.\n`
    : "";

  let retryNote = "";
  if (result.code !== 0 && isTransientBootstrapFailure(`${result.stdout}\n${result.stderr}`)) {
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    retryNote = `Bootstrap install for ${repo.name} failed with a transient-looking registry/resolver error on attempt 1; retrying once after ${retryDelayMs}ms...\n`;
    if (retryDelayMs > 0) await delay(retryDelayMs);
    const retryResult = await runCommand(installCommand.command, { cwd: repoDir, env: installEnv });
    retryNote += retryResult.code === 0
      ? `Bootstrap retry succeeded for ${repo.name} — transient registry/resolver failure recovered on attempt 2.\n`
      : `Bootstrap retry did not recover for ${repo.name} — attempt 2 failed too.\n`;
    result = retryResult;
  }

  await writeFile(logs.stdout, `${engineNote}${normalizationNote}${retryNote}${result.stdout}`);
  await writeFile(logs.stderr, result.stderr);

  if (result.code !== 0) {
    const detail = result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.code}`;
    throw new Error(`Bootstrap install command failed for ${repo.name} with ${detail}; see ${logs.stdout} and ${logs.stderr}`);
  }

  return {
    repoDir,
    envPath,
    logs,
  };
}
