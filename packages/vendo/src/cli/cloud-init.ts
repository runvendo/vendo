import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { DevCredential } from "../dev-creds/resolve.js";
import { runDeviceLogin } from "./cloud/device-login.js";
import { cloudDoctor, type CloudDoctorResult } from "./doctor-live.js";
import { askYesNo, readOptional, writeText, type Output } from "./shared.js";

/**
 * ENG-339 (install-dx design §6) — cloud in init. Detect VENDO_API_KEY when
 * present and check its shape locally (key problems surface on the first real
 * service call), one calm line when absent, and — when a starter model key
 * would actually help the ladder — offer `vendo login` inline: the auth.md
 * user-claimed ceremony approves a code in the browser and lands the minted
 * VENDO_API_KEY in .env.local, so the dev never pastes a key.
 */

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
    "  1. run `vendo login` — it prints a code your human approves in the browser",
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
  /** Fetch seam for the default ceremony (tests script the console with it). */
  fetchImpl?: typeof fetch;
  /** Seams (tests). */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  /** The whole ceremony in one seam (default: runDeviceLogin). */
  deviceLogin?: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
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
  const cloud = await (options.cloudProbe ?? cloudDoctor)({ env });

  if (cloud.present && cloud.ok) {
    output.log("\nVendo Cloud: VENDO_API_KEY present and well-formed.");
    return { keyPresent: true, keyValid: true, wroteEnvLocal: false };
  }
  if (cloud.present) {
    output.error(`\nVendo Cloud: VENDO_API_KEY is set but not usable (${cloud.error ?? "malformed"}). Fix or remove it; \`vendo login\` can issue a fresh one.`);
    return { keyPresent: true, keyValid: false, wroteEnvLocal: false };
  }

  // Absent — one calm line stating what Cloud unlocks.
  output.log(`\nVendo Cloud (optional): not configured. A key unlocks ${cloud.unlocks.join("; ")}.`);

  // A starter model key only helps when the local ladder has nothing better.
  const laddersWantKey = credential.rung === "none" || credential.rung === "vendo-cloud";
  if (options.yes || options.byo === true || !laddersWantKey) {
    if (laddersWantKey) {
      if (options.byo === true) {
        output.log("Run `vendo login` to claim a free dev-mode key; it lands in .env.local.");
      } else {
        // --yes / agent-driven runs get the full auth.md pointer: the agent
        // can complete the whole key story in-band from these lines.
        for (const line of agentKeyPointerLines()) output.log(line);
      }
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  const tty = options.isTty ?? (stdin.isTTY === true && stdout.isTTY === true);
  const confirm = options.confirm ?? askYesNo;
  if (!(await confirm("Log in to Vendo Cloud now for a free dev-mode model key?", false))) {
    if (tty) {
      output.log("Skipped — run `vendo login` any time; the key lands in .env.local.");
    } else {
      // Nobody saw that prompt (non-TTY): this is an agent-driven run that
      // reached here without --yes — point it at the auth.md flow instead.
      for (const line of agentKeyPointerLines()) output.log(line);
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  // The `vendo login` ceremony end to end: approve a code in the browser
  // (TTY opens it), and the minted key lands in .env.local — init picks it
  // up in this same run, so the standalone re-run hint is suppressed.
  const deviceLogin = options.deviceLogin ?? (() => runDeviceLogin(
    options.apiUrl === undefined ? [] : ["--api-url", options.apiUrl],
    {
      output,
      env,
      root,
      isTty: tty,
      rerunHint: false,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
  ));
  if ((await deviceLogin()) !== 0) {
    output.error("Vendo Cloud login did not complete; run `vendo login` and re-run `vendo init`.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  output.log("Production always needs a real server-side key.");
  return { keyPresent: true, keyValid: true, wroteEnvLocal: true };
}
