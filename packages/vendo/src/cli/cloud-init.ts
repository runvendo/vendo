import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { DevCredential } from "../dev-creds/resolve.js";
import { runLogin } from "./cloud/auth.js";
import { CloudError, cloudFetch, isVendoKey, type CloudFetchOptions } from "./cloud/client.js";
import { cloudDoctor, type CloudDoctorResult } from "./doctor-live.js";
import { readOptional, writeText, type Output } from "./shared.js";

/**
 * ENG-339 (install-dx design §6) — cloud in init. Detect VENDO_API_KEY when
 * present and check its shape locally (key problems surface on the first real
 * service call), one calm line when absent, and — when a starter model key
 * would actually help the ladder — offer `vendo cloud login` inline, then
 * mint a metered dev-mode starter allowance and write it to .env.local so the
 * dev never pastes a key.
 *
 * Starter-allowance minting is the Cloud console's POST /api/v1/dev/starter-key
 * (live since the managed-inference lane); against an older console that
 * lacks it, mint returns null and the step degrades to a clear pointer
 * instead of blocking init.
 */

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
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

async function askText(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question(`${question}: `)).trim();
  } finally {
    prompt.close();
  }
}

/**
 * Console hand-off contract (implemented by vendo-web):
 *   POST /api/v1/dev/starter-key      auth: user session (Bearer access token)
 *   request  { purpose: "dev-mode" }
 *   response { key: "vnd_<40 hex>", meter: { runs: { included, remaining } } }
 * The key is a metered dev-mode API key scoped to the caller's default org.
 * Returns null when the endpoint is absent (404 / not-implemented) so init
 * degrades gracefully against older consoles; real auth/network errors
 * propagate.
 */
export async function mintStarterAllowance(
  options: Pick<CloudFetchOptions, "apiUrl" | "env" | "fetchImpl" | "home"> = {},
): Promise<string | null> {
  try {
    const result = await cloudFetch("/api/v1/dev/starter-key", {
      ...options,
      auth: "user",
      method: "POST",
      body: { purpose: "dev-mode" },
    });
    const key = (result as { key?: unknown }).key;
    return typeof key === "string" && isVendoKey(key) ? key : null;
  } catch (error) {
    if (error instanceof CloudError && (error.status === 404 || error.code === "not-implemented")) return null;
    throw error;
  }
}

/** Upsert VENDO_API_KEY in .env.local without clobbering other lines. */
async function upsertEnvLocal(root: string, name: string, value: string): Promise<void> {
  const path = join(root, ".env.local");
  const current = await readOptional(path);
  const line = `${name}=${value}`;
  if (current === null || current.length === 0) {
    await writeText(path, `${line}\n`);
    return;
  }
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (pattern.test(current)) {
    await writeText(path, current.replace(pattern, line));
    return;
  }
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeText(path, `${current}${separator}${line}\n`);
}

export interface CloudStepOptions {
  root: string;
  output: Output;
  yes: boolean;
  /** What the model ladder resolved — decides whether a starter key helps. */
  credential: DevCredential;
  env?: Record<string, string | undefined>;
  apiUrl?: string;
  home?: string;
  /** Fetch seam for the default mint path (tests mock the console with it). */
  fetchImpl?: typeof fetch;
  /** Seams (tests). */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  promptEmail?: (question: string) => Promise<string>;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  login?: (email: string) => Promise<number>;
  mint?: () => Promise<string | null>;
}

export interface CloudStepResult {
  keyPresent: boolean;
  keyValid: boolean;
  wroteEnvLocal: boolean;
}

/** init's cloud step (design §6). Never changes init's exit code. */
export async function runCloudStep(options: CloudStepOptions): Promise<CloudStepResult> {
  const { root, output, credential } = options;
  const env = options.env ?? process.env;
  const cloud = await (options.cloudProbe ?? ((o) => cloudDoctor(o)))({ env });

  if (cloud.present && cloud.ok) {
    output.log("\nVendo Cloud: VENDO_API_KEY present and well-formed.");
    return { keyPresent: true, keyValid: true, wroteEnvLocal: false };
  }
  if (cloud.present) {
    output.error(`\nVendo Cloud: VENDO_API_KEY is set but not usable (${cloud.error ?? "malformed"}). Fix or remove it; \`vendo cloud login\` can issue a fresh one.`);
    return { keyPresent: true, keyValid: false, wroteEnvLocal: false };
  }

  // Absent — one calm line stating what Cloud unlocks.
  output.log(`\nVendo Cloud (optional): not configured. A key unlocks ${cloud.unlocks.join("; ")}.`);

  // A starter model key only helps when the local ladder has nothing better.
  const laddersWantKey = credential.rung === "none" || credential.rung === "vendo-cloud";
  if (options.yes || !laddersWantKey) {
    if (laddersWantKey) {
      output.log("Run `vendo cloud login` to grab a free dev-mode starter key; the wizard writes it to .env.local on your next `vendo init`.");
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const confirm = options.confirm ?? askYesNo;
  if (!(await confirm("Log in to Vendo Cloud now for a free dev-mode model key?", false))) {
    output.log("Skipped — run `vendo cloud login` any time; the wizard will write the key to .env.local.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const email = await (options.promptEmail ?? askText)("Vendo Cloud email");
  if (email.length === 0) {
    output.error("No email entered; skipped Vendo Cloud login.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  const login = options.login ?? ((address: string) => runLogin([address], { home: options.home, env }));
  const exit = await login(email);
  if (exit !== 0) {
    output.error("Vendo Cloud login did not complete; run `vendo cloud login` and re-run `vendo init`.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const key = await (options.mint ?? (() => mintStarterAllowance({
    env,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })))();
  if (key === null) {
    output.error("Logged in, but this console does not serve the dev-mode starter allowance yet (older console). Set a provider key or ride your Claude/Codex CLI for now.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  await upsertEnvLocal(root, "VENDO_API_KEY", key);
  output.log("Wrote VENDO_API_KEY to .env.local (dev-mode starter allowance). Production always needs a real server-side key.");
  return { keyPresent: true, keyValid: true, wroteEnvLocal: true };
}
