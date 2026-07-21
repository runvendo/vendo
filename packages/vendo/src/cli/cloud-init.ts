import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { DevCredential } from "../dev-creds/resolve.js";
import { runLogin } from "./cloud/auth.js";
import { CloudError, cloudFetch, isVendoKey, type CloudFetchOptions } from "./cloud/client.js";
import { cloudDoctor, type CloudDoctorResult } from "./doctor-live.js";
import {
  askYesNo,
  cloudProjectProps,
  errorClass,
  readOptional,
  toolingTelemetry,
  writeText,
  type Output,
  type TelemetryOptions,
} from "./shared.js";

/**
 * ENG-339 (install-dx design §6) — cloud in init. Detect VENDO_API_KEY when
 * present and check its shape locally (key problems surface on the first real
 * service call), one calm line when absent, and — when a starter model key
 * would actually help the ladder — offer `vendo cloud login` inline, then
 * mint a metered dev-mode starter allowance and write it to .env.local so the
 * dev never pastes a key.
 *
 * Starter-allowance minting rides the console's generic POST /api/v1/keys
 * (purpose: "dev-mode"); against a console that lacks it, mint returns null
 * and the step degrades to a clear pointer instead of blocking init.
 */

async function askText(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question(`${question}: `)).trim();
  } finally {
    prompt.close();
  }
}

/**
 * Console hand-off contract (console follow-up moves its live
 * /api/v1/dev/starter-key mint onto this generic path; until that lands the
 * 404 degradation below covers the gap):
 *   POST /api/v1/keys                 auth: user session (Bearer access token)
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
    // One key-mint path for everyone (Yousef 2026-07-18): the generic keys
    // resource; the dev-mode meter comes from the purpose in the body, not a
    // special path.
    const result = await cloudFetch("/api/v1/keys", {
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

/** Upsert one NAME=value line in .env.local without clobbering other lines.
    Exported for init's --cloud-key flag, which lands a supplied key exactly
    where the mint below would. */
export async function upsertEnvLocal(root: string, name: string, value: string): Promise<void> {
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

/** The auth.md protocol file on Vendo Cloud (Agent Install DX, Layer 2). */
export const AUTH_MD_URL = "https://vendo.run/auth.md";

/** The agent-path key pointer: when an agent-driven init needs a Cloud key
    and none exists, this block is the whole story — discovery URL, the CLI
    command that runs the user-claimed ceremony, and both fallbacks (paste a
    key with --cloud-key; stay keyless with --byo). Deterministic lines an
    agent parses; exported so init's tail and the tests share one source. */
export function agentKeyPointerLines(): string[] {
  return [
    `Vendo Cloud key (agent path): fetch ${AUTH_MD_URL} and follow the user-claimed flow —`,
    "  1. run `vendo cloud device-login` — it prints a code your human approves in the browser",
    "  2. the minted VENDO_API_KEY lands in .env.local automatically (never printed)",
    "  3. re-run `vendo init` (it picks the key up from .env.local) or pass --cloud-key <key>",
    "No Cloud account wanted? Re-run with --byo and set a provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY).",
  ];
}

export interface CloudStepOptions {
  root: string;
  output: Output;
  yes: boolean;
  /** --byo: the explicit "no Cloud" answer — skip the offer AND the agent
      pointer (bring-your-own stays first-class, no nudging past it). */
  byo?: boolean;
  /** TTY seam for the decline path (tests pin both sides). */
  isTty?: boolean;
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
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
}

export interface CloudStepResult {
  keyPresent: boolean;
  keyValid: boolean;
  wroteEnvLocal: boolean;
}

/** init's cloud step (design §6). Never changes init's exit code. Tracked as
    `command_run` command "cloud-init" (TELEMETRY.md): ok is "the step ended
    in a non-error outcome" — a valid key, a clean skip/decline, or a minted
    starter key; failures name their step. Telemetry never changes the step's
    behavior: the tracker is fully guarded and a thrown error still rethrows. */
export async function runCloudStep(options: CloudStepOptions): Promise<CloudStepResult> {
  const started = Date.now();
  const telemetry = toolingTelemetry(options.telemetry ?? {});
  const failure: { failedStep?: string } = {};
  const track = async (thrown?: { error: unknown }): Promise<void> => {
    try {
      await telemetry.track("command_run", {
        command: "cloud-init",
        ok: thrown === undefined && failure.failedStep === undefined,
        durationMs: Date.now() - started,
        ...(failure.failedStep === undefined ? {} : { failedStep: failure.failedStep }),
        ...(thrown === undefined ? {} : { errorClass: errorClass(thrown.error) }),
        ...(await cloudProjectProps(options.root)),
      });
    } catch {
      // Telemetry must never break init. Intentional silent failure.
    }
  };
  try {
    const result = await cloudStep(options, failure);
    await track();
    return result;
  } catch (error) {
    await track({ error });
    throw error;
  }
}

async function cloudStep(options: CloudStepOptions, failure: { failedStep?: string }): Promise<CloudStepResult> {
  const { root, output, credential } = options;
  const env = options.env ?? process.env;
  const cloud = await (options.cloudProbe ?? cloudDoctor)({ env });

  if (cloud.present && cloud.ok) {
    output.log("\nVendo Cloud: VENDO_API_KEY present and well-formed.");
    return { keyPresent: true, keyValid: true, wroteEnvLocal: false };
  }
  if (cloud.present) {
    failure.failedStep = "key-invalid";
    output.error(`\nVendo Cloud: VENDO_API_KEY is set but not usable (${cloud.error ?? "malformed"}). Fix or remove it; \`vendo cloud login\` can issue a fresh one.`);
    return { keyPresent: true, keyValid: false, wroteEnvLocal: false };
  }

  // Absent — one calm line stating what Cloud unlocks.
  output.log(`\nVendo Cloud (optional): not configured. A key unlocks ${cloud.unlocks.join("; ")}.`);

  // A starter model key only helps when the local ladder has nothing better.
  const laddersWantKey = credential.rung === "none" || credential.rung === "vendo-cloud";
  if (options.yes || options.byo === true || !laddersWantKey) {
    if (laddersWantKey) {
      if (options.byo === true) {
        output.log("Run `vendo cloud login` to grab a free dev-mode starter key; the wizard writes it to .env.local on your next `vendo init`.");
      } else {
        // --yes / agent-driven runs get the full auth.md pointer: the agent
        // can complete the whole key story in-band from these lines.
        for (const line of agentKeyPointerLines()) output.log(line);
      }
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const confirm = options.confirm ?? askYesNo;
  if (!(await confirm("Log in to Vendo Cloud now for a free dev-mode model key?", false))) {
    const tty = options.isTty ?? (stdin.isTTY === true && stdout.isTTY === true);
    if (tty) {
      output.log("Skipped — run `vendo cloud login` any time; the wizard will write the key to .env.local.");
    } else {
      // Nobody saw that prompt (non-TTY): this is an agent-driven run that
      // reached here without --yes — point it at the auth.md flow instead.
      for (const line of agentKeyPointerLines()) output.log(line);
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const email = await (options.promptEmail ?? askText)("Vendo Cloud email");
  if (email.length === 0) {
    failure.failedStep = "email";
    output.error("No email entered; skipped Vendo Cloud login.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  const login = options.login ?? ((address: string) => runLogin([address], { home: options.home, env }));
  const exit = await login(email);
  if (exit !== 0) {
    failure.failedStep = "login";
    output.error("Vendo Cloud login did not complete; run `vendo cloud login` and re-run `vendo init`.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  // mintStarterAllowance propagates real errors (auth, network, the console's
  // per-org starter-key cap) so callers can show them; THIS caller's contract
  // is "never changes init's exit code", so they land as one clear line here.
  let key: string | null;
  try {
    key = await (options.mint ?? (() => mintStarterAllowance({
      env,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })))();
  } catch (error) {
    failure.failedStep = "mint";
    const message = error instanceof Error ? error.message : String(error);
    output.error(`Vendo Cloud starter-allowance minting failed: ${message} Set a provider key or retry \`vendo init\` later; init continues.`);
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  if (key === null) {
    failure.failedStep = "mint-unsupported";
    output.error("Logged in, but this console does not serve the dev-mode starter allowance yet (older console). Set a provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) for now.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  await upsertEnvLocal(root, "VENDO_API_KEY", key);
  output.log("Wrote VENDO_API_KEY to .env.local (dev-mode starter allowance). Production always needs a real server-side key.");
  return { keyPresent: true, keyValid: true, wroteEnvLocal: true };
}
