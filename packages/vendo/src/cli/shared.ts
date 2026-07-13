import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";

export const CLI_VERSION = "0.3.0";

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export const consoleOutput: Output = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

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

export function noTelemetry(): Telemetry {
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
