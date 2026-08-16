import { execFile, type ExecFileException } from "node:child_process";
import { realpath } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import { ENV_KEY_VARS, type DevCredential } from "../dev-creds/resolve.js";
import { runDeviceLogin } from "./cloud/device-login.js";
import { cloudDoctor, type CloudDoctorResult } from "./doctor-live.js";
import type { SelectOption } from "./pretty.js";
import {
  askYesNo,
  cloudProjectProps,
  errorClass,
  exists,
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
 * would actually help the ladder — offer `vendo login` inline: the auth.md
 * user-claimed ceremony approves a code in the browser and lands the minted
 * VENDO_API_KEY in .env.local, so the dev never pastes a key.
 */

/** Upsert one NAME=value line in .env.local without clobbering other lines.
    Exported for init's --cloud-key flag, which lands a supplied key exactly
    where the mint below would, and for the bring-your-own-key paste. Every
    caller follows the write with `ensureEnvLocalIgnored` — a secret just
    landed on disk. */
export async function upsertEnvLocal(root: string, name: string, value: string): Promise<void> {
  const path = join(root, ".env.local");
  const current = (await readOptional(path)) ?? "";
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  await writeText(path, pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
}

/** What git says about the .env.local a secret just landed in. */
type EnvLocalState =
  /** Ignored, or outside a work tree — nothing to leak into. */
  | { kind: "safe" }
  /** Not ignored and not tracked: one line in .gitignore fixes it. */
  | { kind: "add"; name: string }
  /** Already in the index — .gitignore alone will not stop the next commit. */
  | { kind: "tracked"; name: string }
  | { kind: "unknown"; name: string; reason: string };

async function envLocalState(root: string): Promise<EnvLocalState> {
  // The write follows symlinks, so the file git must be asked about is the REAL
  // one: a .env.local that is itself gitignored can point straight at a tracked
  // file, and asking about the link would call that safe. Both sides resolved,
  // or the name is nonsense whenever the ROOT itself sits under a link (every
  // macOS temp dir: /var → /private/var). Ask the repository that holds the
  // SECRET, which a link can move — or take out of every working tree, where
  // there is nothing to leak into.
  const link = join(root, ".env.local");
  const file = await realpath(link).catch(() => link);
  const name = relative(await realpath(root).catch(() => root), file);
  const where = dirname(file);
  if (!(await insideWorkTree(where))) return { kind: "safe" };

  const verdict = await gitCheckIgnore(where, file);
  if (verdict.kind === "ignored") return { kind: "safe" };
  if (verdict.kind === "unknown") return { kind: "unknown", name, reason: verdict.reason };
  // check-ignore answers from the patterns alone, so it calls a TRACKED file
  // "not ignored" even when a pattern matches it — and a file already in the
  // index commits no matter what .gitignore says. Only `git rm --cached` undoes
  // that, so the index is what decides between the two remedies.
  if (await gitTracks(where, file)) return { kind: "tracked", name };
  return { kind: "add", name };
}

function reportEnvLocalRisk(state: EnvLocalState, output: Output): void {
  if (state.kind === "unknown") {
    output.error(`warning: ${state.name} holds a secret and git could not say whether it is ignored (${state.reason}) — check it yourself before you commit.`);
  } else if (state.kind === "tracked") {
    output.error(`warning: ${state.name} holds a secret and is TRACKED by git — .gitignore alone will NOT stop the next commit: run \`git rm --cached ${state.name}\`, then add \`${state.name}\` to .gitignore.`);
  }
}

/** The single answer to "we just wrote a secret to disk". A secret in an
    unignored, UNTRACKED file is a one-line fix, so it gets made and reported
    instead of turned into homework. The tracked case is the one branch that
    must not be silently "fixed" — .gitignore does nothing for a file already
    in the index — so it keeps its warning, verbatim, and so does the case
    where git cannot answer at all. Never blocks the write: the key is already
    minted and unrecoverable, so the dev needs to know, not to be stopped.
    Returns the line added, or null when nothing was written. */
export async function ensureEnvLocalIgnored(root: string, output: Output): Promise<string | null> {
  const state = await envLocalState(root);
  reportEnvLocalRisk(state, output);
  if (state.kind !== "add") return null;
  const path = join(root, ".gitignore");
  const current = (await readOptional(path)) ?? "";
  await writeText(path, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${state.name}\n`);
  output.log(`Added ${state.name} to .gitignore`);
  return state.name;
}

/** Which variable a pasted provider key belongs in, read off the key's own
    prefix. null means "cannot tell" — ask, never guess: a key in the wrong
    variable fails at the first turn as a provider mismatch, not a bad key. */
export function providerKeyVar(key: string): string | null {
  const value = key.trim();
  if (value.startsWith("sk-ant-")) return "ANTHROPIC_API_KEY";
  if (value.startsWith("sk-")) return "OPENAI_API_KEY";
  if (value.startsWith("AIza")) return "GOOGLE_GENERATIVE_AI_API_KEY";
  return null;
}

/** Is this path inside a git working tree? Answered by walking up for a `.git`
    entry (a directory, or the file a worktree/submodule uses) — never by
    matching git's stderr, which a localized git translates: deciding "no
    repository" from English text is how an outside-repo write starts warning
    and a broken repo inside one goes quiet. */
async function insideWorkTree(from: string): Promise<boolean> {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Exit 0 only when the path is in the index — every other outcome is "not
    tracked". Asked only after check-ignore reported "not ignored", so the
    common (ignored) case costs no second subprocess. */
function gitTracks(cwd: string, path: string): Promise<boolean> {
  return new Promise((settle) => {
    execFile("git", ["ls-files", "--error-unmatch", "--", path], { cwd }, (error) => settle(error === null));
  });
}

type IgnoreVerdict = { kind: "ignored" } | { kind: "not-ignored" } | { kind: "unknown"; reason: string };

/** `git check-ignore` is the only authority that reads nested .gitignore files
    and negations correctly: exit 0 is "ignored", exit 1 is "not ignored". The
    caller has already established that a working tree exists, so any OTHER
    exit is a repository that cannot answer (dubious ownership, an unreadable
    config, no git binary) and must never pass for "ignored". git's own stderr
    is quoted to the human but never parsed for the decision. */
function gitCheckIgnore(cwd: string, path: string): Promise<IgnoreVerdict> {
  return new Promise((settle) => {
    execFile("git", ["check-ignore", "-q", "--", path], { cwd }, (error, _stdout, stderr) => {
      if (error === null) return settle({ kind: "ignored" });
      if ((error as ExecFileException).code === 1) return settle({ kind: "not-ignored" });
      const reported = stderr.trim().split("\n")[0];
      const reason = reported !== undefined && reported.length > 0
        ? reported.slice(0, 200)
        : ((error as ExecFileException).code === "ENOENT" ? "git is not installed" : "git failed");
      settle({ kind: "unknown", reason });
    });
  });
}

/** The auth.md protocol file on Vendo Cloud (Agent Install DX, Layer 2). */
export const AUTH_MD_URL = "https://vendo.run/auth.md";

/** The agent-path key pointer: when an agent-driven init needs a Cloud key
    and none exists, this block is the whole story — the CLI command that runs
    the user-claimed ceremony, its discovery URL, and both fallbacks (paste a
    key with --cloud-key; stay keyless with --byo). Three lines, not the full
    device-flow walkthrough: `vendo login` narrates its own ceremony step by
    step, and the upsell used to open a keyless init before the user learned
    what init did (self-serve audit F8). Deterministic lines an agent parses;
    exported so init's tail and the tests share one source. */
export function agentKeyPointerLines(): string[] {
  return [
    "Vendo Cloud key (agent path): run `vendo login` — it prints a code your human approves in the browser, and the minted VENDO_API_KEY lands in .env.local (never printed).",
    `Then re-run \`vendo init\` (it picks the key up) or pass --cloud-key <key>. Protocol: ${AUTH_MD_URL}`,
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
  /** How models run, answered up front instead of asked (--cloud-key ⇒
      "cloud", --byo ⇒ "byo"). */
  models?: ModelsAnswer;
  /** Seams (tests). */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** The models question as a select — Cloud first and recommended, BYO one
      keystroke away, "decide later" the graceful exit. Absent (plain
      terminals, tests) keeps today's confirm. */
  select?: (question: string, options: SelectOption[]) => Promise<string>;
  /** The masked prompt behind "bring my own key". */
  askSecret?: (question: string, hint?: string) => Promise<string>;
  /** The pretty renderer is driving: the ceremony drops its machine-readable
      receipt, which is noise under a rail. Every machine-consumed path keeps
      it — see DeviceLoginOptions.pretty. */
  pretty?: boolean;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  /** The whole ceremony in one seam (default: runDeviceLogin). */
  deviceLogin?: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
}

export interface CloudStepResult {
  keyPresent: boolean;
  keyValid: boolean;
  wroteEnvLocal: boolean;
  /** The provider variable a bring-your-own-key paste landed in this run —
      re-merged by the caller exactly like a minted VENDO_API_KEY, so THIS
      run's model passes already benefit from the key just pasted. */
  wroteKeyVar?: string;
}

/** The three answers to "how do you want to run models?". */
export type ModelsAnswer = "cloud" | "byo" | "later";

const MODELS_QUESTION = "How do you want to run models?";
const MODELS_OPTIONS: SelectOption[] = [
  { value: "cloud", label: "Vendo Cloud — free key in ~30s", hint: "recommended" },
  { value: "byo", label: "Bring my own key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_…)" },
  { value: "later", label: "Decide later" },
];

/** init's cloud step (design §6). Never changes init's exit code. Tracked as
    `command_run` command "cloud-init" (TELEMETRY.md): ok is "the step ended
    in a non-error outcome" — a valid key, a clean skip/decline, or a minted
    starter key; failures name their step. Telemetry never changes the step's
    behavior: the tracker is fully guarded and a thrown error still rethrows. */
export async function runCloudStep(options: CloudStepOptions): Promise<CloudStepResult> {
  const started = Date.now();
  // The step's target root is the client's cwd: projectIdHash and the
  // .env.local cloud-key read attribute to the project init runs against.
  const telemetry = toolingTelemetry({ cwd: options.root, ...(options.telemetry ?? {}) });
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
    output.error(`\nVendo Cloud: VENDO_API_KEY is set but not usable (${cloud.error ?? "malformed"}). Fix or remove it; \`vendo login\` can issue a fresh one.`);
    return { keyPresent: true, keyValid: false, wroteEnvLocal: false };
  }

  // Absent — one calm line stating what Cloud unlocks.
  output.log(`\nVendo Cloud (optional): not configured. A key unlocks ${cloud.unlocks.join("; ")}.`);

  // A starter model key only helps when the local ladder has nothing better.
  const laddersWantKey = credential.rung === "none" || credential.rung === "vendo-cloud";
  const tty = options.isTty ?? (stdin.isTTY === true && stdout.isTTY === true);
  const answered = options.models ?? (options.byo === true ? "byo" : undefined);

  // Bring-your-own with no key in the environment: the branch that settles
  // itself instead of assigning homework. Only where a human can actually
  // paste — unattended runs keep the one-line pointer below.
  if (answered === "byo" && laddersWantKey && tty && options.askSecret !== undefined) {
    return pasteProviderKey(options, options.askSecret);
  }

  if (options.yes || options.byo === true || !laddersWantKey) {
    if (laddersWantKey) {
      if (options.byo === true) {
        // --byo is the ANSWER, so this states what their own key needs and
        // stops. Nudging back to `vendo login` here is what made the opt-out
        // read as a detour rather than a first-class path.
        output.log("Your own key: set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) in .env.local, then select it in your composition's `models`.");
      } else {
        // --yes / agent-driven runs get the full auth.md pointer: the agent
        // can complete the whole key story in-band from these lines.
        for (const line of agentKeyPointerLines()) output.log(line);
      }
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  // The select is for a terminal a human is actually watching — pretty or
  // not. The non-TTY guard stops it PROMPTING, but it does not stop it
  // answering: its silent fallback is the first option, and the first option
  // is Cloud, so an unattended run would start a device login nobody asked
  // for. The confirm's default is No, which is the answer an unshown question
  // must have, so a non-TTY run keeps taking it.
  const confirm = options.confirm ?? askYesNo;
  const chosen: ModelsAnswer = answered
    ?? (options.select === undefined || !tty
      ? (await confirm("Log in to Vendo Cloud now for a free API key (starter model allowance included)?", false) ? "cloud" : "later")
      : (await options.select(MODELS_QUESTION, MODELS_OPTIONS)) as ModelsAnswer);
  if (chosen === "byo" && tty && options.askSecret !== undefined) {
    return pasteProviderKey(options, options.askSecret);
  }
  if (chosen !== "cloud") {
    if (tty) {
      output.log("Skipped — run `vendo login` any time; the key lands in .env.local.");
    } else {
      // Nobody saw that prompt (non-TTY): this is an agent-driven run that
      // reached here without --yes — point it at the auth.md flow instead.
      for (const line of agentKeyPointerLines()) output.log(line);
    }
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }

  // The key is about to land in .env.local, so make the file safe to hold a
  // secret BEFORE it holds one: one consented line instead of a wall of
  // yellow after the fact. Doing it here also keeps the ceremony's own
  // after-the-write check silent, so the run reports the fix once.
  await ensureEnvLocalIgnored(root, output);

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
      ...(options.pretty === true ? { pretty: true } : {}),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
  ));
  if ((await deviceLogin()) !== 0) {
    failure.failedStep = "login";
    output.error("Vendo Cloud login did not complete; run `vendo login` and re-run `vendo init`.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  return { keyPresent: true, keyValid: true, wroteEnvLocal: true };
}

/** "Bring my own key", answered at the moment the user has already decided,
    with the key on their clipboard: paste it, land it in .env.local through
    the same generic writer the mint uses, and report only the last four
    characters. An unrecognisable prefix asks which variable rather than
    guessing one. */
async function pasteProviderKey(
  options: CloudStepOptions,
  askSecret: NonNullable<CloudStepOptions["askSecret"]>,
): Promise<CloudStepResult> {
  const { root, output } = options;
  const key = (await askSecret(
    "Paste your key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_…) — lands in .env.local, never committed:",
  )).trim();
  if (key === "") {
    output.log("Run `vendo login` to claim a free API key; it lands in .env.local.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  const detected = providerKeyVar(key);
  const name = detected ?? (options.select === undefined
    ? ENV_KEY_VARS[0]!.envVar
    : await options.select(
      "Which variable is that key for?",
      ENV_KEY_VARS.map(({ envVar, provider }) => ({ value: envVar, label: envVar, hint: provider })),
    ));
  await upsertEnvLocal(root, name, key);
  output.log(`${name} saved to .env.local (…${key.slice(-4)})`);
  await ensureEnvLocalIgnored(root, output);
  return { keyPresent: false, keyValid: false, wroteEnvLocal: false, wroteKeyVar: name };
}
