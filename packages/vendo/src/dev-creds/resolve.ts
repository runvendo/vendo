import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * ENG-338 — the dev-mode model-credential ladder (install-dx design §2).
 * Resolved at init and reused by the runtime's dev mode and extraction
 * `--deep`: one credential story. Detection is PURE and read-only — no
 * network, no writes, no key material in the result (consumers read the env
 * variable themselves). Order (explicit beats implicit):
 *
 *   1. explicit env key (ANTHROPIC / OPENAI / GOOGLE)
 *   2. authed Claude Code session   (consent asked by the wizard before use)
 *   3. authed Codex session         (officially sanctioned by OpenAI)
 *   4. VENDO_API_KEY                (cloud starter allowance — wave 3 mints it)
 *   5. none                         (honest failure with exact instructions)
 *
 * Session rungs are REFUSED when NODE_ENV === "production": production
 * deploys always require a real server-side key.
 */

export type EnvKeyProvider = "anthropic" | "openai" | "google";

export type DevCredential =
  | { rung: "env-key"; provider: EnvKeyProvider; envVar: string }
  | { rung: "claude-session" }
  | { rung: "codex-session" }
  | { rung: "vendo-cloud" }
  | { rung: "none" };

export const ENV_KEY_VARS: ReadonlyArray<{ envVar: string; provider: EnvKeyProvider }> = [
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", provider: "google" },
];

export interface ResolveDevCredentialOptions {
  env?: Record<string, string | undefined>;
  /** Test seams for the CLI probes. */
  probes?: {
    claude?: () => Promise<boolean>;
    codex?: () => Promise<boolean>;
  };
}

const PROBE_TIMEOUT_MS = 5_000;

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve({ code: error === null ? 0 : 1, stdout: stdout ?? "" });
    });
  });
}

/** `claude auth status` prints JSON with a `loggedIn` boolean. */
export async function probeClaudeSession(): Promise<boolean> {
  const result = await run("claude", ["auth", "status"]);
  if (result.code !== 0) return false;
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/** `codex login status` exits 0 when a login is present. */
export async function probeCodexSession(): Promise<boolean> {
  return (await run("codex", ["login", "status"])).code === 0;
}

function present(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/** Detect the best available dev-mode credential. `VENDO_DEV_CREDENTIAL`
 *  (env-key:anthropic | claude-session | codex-session | vendo-cloud | none)
 *  pins the rung explicitly — used by E2E rung matrices and escape hatches —
 *  but session rungs stay refused in production even when pinned. */
export async function resolveDevCredential(
  options: ResolveDevCredentialOptions = {},
): Promise<DevCredential> {
  const env = options.env ?? process.env;
  const production = env["NODE_ENV"] === "production";

  const pinned = env["VENDO_DEV_CREDENTIAL"]?.trim();
  if (pinned !== undefined && pinned.length > 0) {
    if (pinned === "claude-session" || pinned === "codex-session") {
      return production ? { rung: "none" } : { rung: pinned };
    }
    if (pinned === "vendo-cloud" || pinned === "none") return { rung: pinned };
    const match = /^env-key:(anthropic|openai|google)$/.exec(pinned);
    if (match !== null) {
      const provider = match[1] as EnvKeyProvider;
      const envVar = ENV_KEY_VARS.find((entry) => entry.provider === provider)!.envVar;
      return present(env, envVar) ? { rung: "env-key", provider, envVar } : { rung: "none" };
    }
  }

  for (const { envVar, provider } of ENV_KEY_VARS) {
    if (present(env, envVar)) return { rung: "env-key", provider, envVar };
  }

  if (!production) {
    const claude = options.probes?.claude ?? probeClaudeSession;
    if (await claude()) return { rung: "claude-session" };
    const codex = options.probes?.codex ?? probeCodexSession;
    if (await codex()) return { rung: "codex-session" };
  }

  if (present(env, "VENDO_API_KEY")) return { rung: "vendo-cloud" };
  return { rung: "none" };
}

/** One human line for the wizard / doctor / runtime log. */
export function describeDevCredential(credential: DevCredential): string {
  switch (credential.rung) {
    case "env-key":
      return `explicit ${credential.envVar} (${credential.provider})`;
    case "claude-session":
      return "your authed Claude Code session (dev only)";
    case "codex-session":
      return "your authed Codex session (dev only)";
    case "vendo-cloud":
      return "VENDO_API_KEY (Vendo Cloud)";
    case "none":
      return "no model credential found";
  }
}

/* ------------------------------------------------------------------------ *
 * Session-rung consent. The wizard asks before any CLI-session use and
 * records the answer per machine under .vendo/data/ (gitignored — consent is
 * personal, never committed). VENDO_DEV_ALLOW_SESSIONS=1 is the
 * non-interactive equivalent (CI, agents, E2E).
 * ------------------------------------------------------------------------ */

const CONSENT_FORMAT = "vendo/dev-credential@1";

export interface DevSessionConsent {
  rung: "claude-session" | "codex-session";
  consentedAt: string;
}

function consentPath(root: string): string {
  return join(root, ".vendo", "data", "dev-credential.json");
}

export async function readDevSessionConsent(root: string): Promise<DevSessionConsent | null> {
  try {
    const parsed = JSON.parse(await readFile(consentPath(root), "utf8")) as {
      format?: unknown;
      rung?: unknown;
      consentedAt?: unknown;
    };
    if (parsed.format !== CONSENT_FORMAT) return null;
    if (parsed.rung !== "claude-session" && parsed.rung !== "codex-session") return null;
    return { rung: parsed.rung, consentedAt: typeof parsed.consentedAt === "string" ? parsed.consentedAt : "" };
  } catch {
    return null;
  }
}

export async function writeDevSessionConsent(
  root: string,
  rung: DevSessionConsent["rung"],
): Promise<void> {
  const path = consentPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ format: CONSENT_FORMAT, rung, consentedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

/** Whether the machine has recorded consent for the given session rung. */
export async function hasSessionConsent(
  root: string,
  rung: "claude-session" | "codex-session",
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (env["VENDO_DEV_ALLOW_SESSIONS"] === "1") return true;
  const consent = await readDevSessionConsent(root);
  return consent !== null && consent.rung === rung;
}
