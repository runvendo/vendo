import { readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initTelemetry, repoHost, type Telemetry } from "@vendoai/telemetry";

export const CLI_VERSION = "0.4.6";

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export const consoleOutput: Output = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return ["y", "yes"].includes(answer);
  } finally {
    prompt.close();
  }
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function noTelemetry(): Telemetry {
  return { async track() {} };
}

/** The injectable telemetry deps every CLI command's options carry
    (init/doctor already ride this exact shape). */
export interface TelemetryOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  posthogKey?: string;
  fetchImpl?: typeof fetch;
  /** The command's TARGET project dir: projectIdHash/packageManager derive
      from it (not the shell cwd — `vendo sync ../app` must attribute to
      ../app), and it is where the .env.local cloud-key read looks. Defaults
      to process.cwd(). */
  cwd?: string;
}

/**
 * The value of one NAME=value line in `<root>/.env.local`. Matches dotenv
 * semantics for hand-authored entries: surrounding quotes are stripped, and
 * unquoted values lose their ` #…` inline comment. Non-throwing: a missing
 * or unreadable file is null. Sync on purpose — telemetry client creation is
 * synchronous.
 */
export function envLocalValueSync(root: string, name: string): string | null {
  try {
    const raw = readFileSync(join(root, ".env.local"), "utf8");
    const match = raw.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
    const value = match?.[1];
    if (value === undefined) return null;
    return normalizeDotEnvValue(value);
  } catch {
    return null;
  }
}

/** One value grammar for every CLI dotenv reader (envLocalValueSync, doctor's
 * readDotEnvFallback): matching surrounding quotes are stripped; unquoted
 * values lose their ` #…` inline comment. */
export function normalizeDotEnvValue(value: string): string {
  const quoted = value.match(/^(["'])(.*)\1$/);
  if (quoted?.[2] !== undefined) return quoted[2];
  return value.replace(/\s+#.*$/, "").trimEnd();
}

export function toolingTelemetry(options: TelemetryOptions & {
  log?: (message: string) => void;
} = {}): Telemetry {
  try {
    let env = options.env ?? process.env;
    // Cloud-lane key sourcing widens to the project's .env.local — exactly
    // where `vendo login` / cloud-init / --cloud-key land the key — because
    // a dev-mode key almost never lives in the process env. Only
    // VENDO_API_KEY widens: consent vars (DO_NOT_TRACK, CI, …) keep coming
    // from the caller's env untouched, and an explicit non-blank env value
    // always wins over .env.local (the same precedence init's credential
    // merge uses).
    if ((env.VENDO_API_KEY ?? "").trim() === "") {
      const stored = envLocalValueSync(options.cwd ?? process.cwd(), "VENDO_API_KEY");
      if (stored !== null) env = { ...env, VENDO_API_KEY: stored };
    }
    return initTelemetry({
      version: CLI_VERSION,
      runtime: false,
      home: options.home,
      env,
      cwd: options.cwd,
      posthogKey: options.posthogKey ?? process.env.VENDO_POSTHOG_KEY,
      fetchImpl: options.fetchImpl,
      log: options.log,
    });
  } catch {
    return noTelemetry();
  }
}

export function errorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return "unknown";
}

/** The closed `command_run.command` enum (TELEMETRY.md). init keeps its own
    richer events; "theme" is reserved — no `vendo theme` entrypoint exists
    yet. "login" is the top-level claim ceremony; init's embedded run of the
    same ceremony stays "cloud-init". */
export type CommandName =
  | "login"
  | "extract"
  | "theme"
  | "eject"
  | "playground"
  | "refine"
  | "sync"
  | "cloud-init"
  | "mcp";

/** Cloud-lane project identity (projectName + repoHost) for commands that
    have a target project dir. Anonymous-lane sends strip both keys. */
export async function cloudProjectProps(root: string | undefined): Promise<Record<string, unknown>> {
  if (root === undefined) return {};
  const props: Record<string, unknown> = {};
  try {
    const name = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) props.projectName = name;
  } catch {
    // No usable package.json — the cloud lane just omits projectName.
  }
  const forge = repoHost(root);
  if (forge !== undefined) props.repoHost = forge;
  return props;
}

/**
 * Run a CLI command body with one `command_run` telemetry row: ok is the
 * exit code (0 = true), a throw records the error class and rethrows, and a
 * body can name the step it failed at via the mutable `failure` argument.
 * The body also receives the telemetry client for extra events (extract's
 * `extract_completed`). Telemetry NEVER changes command behavior or exit
 * codes — the client never throws, and this wrapper's own prop assembly is
 * guarded too.
 */
export async function withCommandRun(
  input: {
    command: CommandName;
    telemetry?: TelemetryOptions;
    /** Host project dir for the cloud lane's projectName/repoHost; omitted
        for commands without a target project (playground, mcp). */
    root?: string;
  },
  body: (failure: { failedStep?: string }, telemetry: Telemetry) => Promise<number>,
): Promise<number> {
  const started = Date.now();
  // The first-run notice keeps its console.error default — several wrapped
  // commands (sync --json, mcp server-json) own their stdout byte-for-byte.
  // The target root rides in as the client's cwd so projectIdHash and the
  // .env.local cloud-key read attribute to the project being operated on,
  // not the shell cwd (an explicit seam cwd still wins).
  const telemetry = toolingTelemetry({
    ...(input.root === undefined ? {} : { cwd: input.root }),
    ...(input.telemetry ?? {}),
  });
  const failure: { failedStep?: string } = {};
  const track = async (ok: boolean, thrown?: { error: unknown }): Promise<void> => {
    try {
      await telemetry.track("command_run", {
        command: input.command,
        ok,
        durationMs: Date.now() - started,
        ...(failure.failedStep === undefined ? {} : { failedStep: failure.failedStep }),
        ...(thrown === undefined ? {} : { errorClass: errorClass(thrown.error) }),
        ...(await cloudProjectProps(input.root)),
      });
    } catch {
      // Telemetry must never break a command. Intentional silent failure.
    }
  };
  try {
    const exit = await body(failure, telemetry);
    await track(exit === 0);
    return exit;
  } catch (error) {
    await track(false, { error });
    throw error;
  }
}

/** Lockfile-derived package manager for `run dev` (doctor's probe starter). */
export async function detectPackageManager(root: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock"))) return "bun";
  return "npm";
}
