import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";

export const CLI_VERSION = "0.4.0";

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

export function toolingTelemetry(options: {
  home?: string;
  env?: Record<string, string | undefined>;
  posthogKey?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
} = {}): Telemetry {
  try {
    return initTelemetry({
      version: CLI_VERSION,
      runtime: false,
      home: options.home,
      env: options.env ?? process.env,
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

/** Lockfile-derived package manager for `run dev` (doctor's probe starter). */
export async function detectPackageManager(root: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock"))) return "bun";
  return "npm";
}
