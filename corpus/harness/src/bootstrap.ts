import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAppRoot } from "./app-root.js";
import { normalizeBootstrapInstallCommand } from "./install-command.js";
import type { ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export type BootstrapRepo = Pick<ManifestEntry, "name" | "appDir" | "localPath" | "bootstrap">;

export interface BootstrapOptions {
  context?: CorpusRunContext;
  env?: NodeJS.ProcessEnv;
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

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
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

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

function runInstallCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
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
  const installCommand = normalizeBootstrapInstallCommand(repo.bootstrap.installCommand, {
    dropIgnoreWorkspace: hasPnpmWorkspace,
  });
  const result = await runInstallCommand(installCommand.command, repoDir, env);
  const normalizationNote = installCommand.changed
    ? `Corpus harness normalized bootstrap install command from "${repo.bootstrap.installCommand}" to "${installCommand.command}" so lockfile updates are allowed.\n`
    : "";
  await writeFile(logs.stdout, `${normalizationNote}${result.stdout}`);
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
