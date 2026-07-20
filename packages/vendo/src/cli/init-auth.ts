import { join } from "node:path";
import type { SelectOption } from "./pretty.js";
import { readOptional } from "./shared.js";

/** The auth families init detects in package.json (09-vendo §2.1). Preset
    names double as the zero-arg `@vendoai/vendo/server` export names. */
export type AuthPresetName = "authJs" | "clerk" | "supabase" | "auth0";

export interface AuthMatch {
  preset: AuthPresetName;
  dependency: string;
  /** How the family was chosen: detection (default) cites the dependency it
      found; a picker pick says so honestly — nothing was detected. */
  source?: "picked";
}

export interface AuthDetection {
  /** Exactly one family matched — the preset init wires silently. */
  wired: AuthMatch | null;
  /** Every family that matched (for the ambiguity advisory). */
  matches: AuthMatch[];
}

export const AUTH_FAMILIES: ReadonlyArray<{ preset: AuthPresetName; test: (dependency: string) => boolean }> = [
  { preset: "authJs", test: (dependency) => dependency === "next-auth" || dependency.startsWith("@auth/") },
  { preset: "clerk", test: (dependency) => dependency.startsWith("@clerk/") },
  { preset: "supabase", test: (dependency) => dependency.startsWith("@supabase/") },
  { preset: "auth0", test: (dependency) => dependency.startsWith("@auth0/") },
];

/** Silent auth-preset detection from the host's package.json (zero-question
    contract): one unambiguous family gets wired; none or several stay
    anonymous and become one advisory line (detection-as-advice). */
export async function detectAuthPreset(root: string): Promise<AuthDetection> {
  let dependencies: string[] = [];
  try {
    const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  } catch {
    // No readable manifest — nothing to detect; anonymous is the safe default.
  }
  const matches = AUTH_FAMILIES.flatMap(({ preset, test }) => {
    const dependency = dependencies.find(test);
    return dependency === undefined ? [] : [{ preset, dependency }];
  });
  return { wired: matches.length === 1 ? matches[0]! : null, matches };
}

/** The one calm auth line for the none/ambiguous cases — names the exact
    line to add, never asks a question. Emitted only when init scaffolds the
    composition (a hand-wired host may already have auth). */
export function authAdvisory(detection: AuthDetection, compositionPath: string): string | null {
  if (detection.wired !== null) return null;
  if (detection.matches.length === 0) {
    return `Auth: no provider detected — sessions stay anonymous. When you add one, add one line in ${compositionPath}: ` +
      `auth: authJs() (Auth.js), clerk(), supabase(), auth0(), or jwt({ secret }).`;
  }
  const names = detection.matches.map((match) => match.dependency).join(", ");
  const calls = detection.matches.map((match) => `auth: ${match.preset}()`).join(" or ");
  return `Auth: several providers detected (${names}) — staying anonymous rather than guessing. Add one line in ${compositionPath}: ${calls}.`;
}

/** The declined-confirm advisory: anonymous composition, exact line in hand. */
export function declinedAuthAdvisory(match: AuthMatch, compositionPath: string): string {
  return `Auth: left anonymous. To wire ${match.dependency} later, add one line in ${compositionPath}: auth: ${match.preset}().`;
}

export type ConfirmAuth = (question: string, defaultYes: boolean) => Promise<boolean>;
export type SelectAuth = (question: string, options: SelectOption[]) => Promise<string>;

/** Picker labels + the runtime package each zero-arg preset lazy-loads (the
    install hint when the picked family's SDK is absent; the preset's own
    lazy-load error already guards runtime). */
export const AUTH_FAMILY_INFO: Record<AuthPresetName, { name: string; label: string; runtime: string }> = {
  authJs: { name: "Auth.js", label: "authJs() — Auth.js / next-auth", runtime: "@auth/core" },
  clerk: { name: "Clerk", label: "clerk() — Clerk", runtime: "@clerk/backend" },
  supabase: { name: "Supabase Auth", label: "supabase() — Supabase Auth", runtime: "jose" },
  auth0: { name: "Auth0", label: "auth0() — Auth0", runtime: "jose" },
};

/** The auth picker (decline or ambiguity): none — stay anonymous — is first
    and the default; detected families come next (named), then the remaining
    zero-arg presets, then jwt (recipe only — it cannot be zero-arg). */
export async function pickScaffoldAuth(
  detection: AuthDetection,
  compositionPath: string,
  selectAuth: SelectAuth,
): Promise<{ wired: AuthMatch | null; advice: string | null }> {
  const detected = detection.matches;
  const undetected = (Object.keys(AUTH_FAMILY_INFO) as AuthPresetName[])
    .filter((preset) => !detected.some((match) => match.preset === preset));
  const picked = await selectAuth("Which auth should Vendo wire?", [
    { value: "none", label: "none — stay anonymous, add it later" },
    ...detected.map((match) => ({
      value: match.preset,
      label: AUTH_FAMILY_INFO[match.preset].label,
      hint: `detected ${match.dependency}`,
    })),
    ...undetected.map((preset) => ({ value: preset, label: AUTH_FAMILY_INFO[preset].label })),
    { value: "jwt", label: "jwt — my own JWT scheme (prints the recipe)" },
  ]);
  if (picked === "jwt") {
    // jwt() cannot be zero-arg — nothing is wired; the recipe is the answer.
    return {
      wired: null,
      advice: `Auth: your own JWT — add one line in ${compositionPath}: auth: jwt({ secret: <your signing secret> }). ` +
        "Options and the claim mapping: docs/act-as-presets.md.",
    };
  }
  const detectedMatch = detected.find((match) => match.preset === picked);
  if (detectedMatch !== undefined) return { wired: detectedMatch, advice: null };
  if (picked in AUTH_FAMILY_INFO) {
    // Picked without its SDK in package.json: wire it exactly like a
    // detection-accept, plus one install hint.
    const preset = picked as AuthPresetName;
    const info = AUTH_FAMILY_INFO[preset];
    return {
      wired: { preset, dependency: info.runtime, source: "picked" },
      advice: `Auth: ${preset}() wired — ${info.runtime} is not in package.json yet; install it ` +
        `(npm install ${info.runtime}) before the first authenticated run (the preset fails loud until then).`,
    };
  }
  // none (or anything unrecognized): today's decline behavior.
  return detection.wired !== null
    ? { wired: null, advice: declinedAuthAdvisory(detection.wired, compositionPath) }
    : { wired: null, advice: authAdvisory(detection, compositionPath) };
}

/** Detect + confirm + choose: in interactive runs, exactly one detected
    family gets ONE calm [Y/n] question before anything is written (Enter
    accepts and wires it — no picker on the happy path). A decline — and the
    ambiguous case (several families) — offers the picker instead of settling
    for anonymous. Without the seams (non-interactive, --yes, --agent) silent
    detection stands and none/ambiguous keep the advisory line — a default
    has to exist. None-detected never asks: there is nothing to choose from
    that the advisory doesn't already name. */
export async function resolveScaffoldAuth(
  root: string,
  compositionPath: string,
  authAnswer: AuthPresetName | "jwt" | "none" | undefined,
  confirmAuth: ConfirmAuth | undefined,
  selectAuth: SelectAuth | undefined,
): Promise<{ wired: AuthMatch | null; advice: string | null }> {
  const detection = await detectAuthPreset(root);
  // --auth answers the confirm AND the picker in one flag: route it through
  // the picker path so a flag answer and an interactive pick wire identically
  // (detection-accept, install hint, jwt recipe, none advisory).
  if (authAnswer !== undefined) {
    return pickScaffoldAuth(detection, compositionPath, async () => authAnswer);
  }
  if (confirmAuth === undefined) {
    return { wired: detection.wired, advice: authAdvisory(detection, compositionPath) };
  }
  if (detection.wired !== null) {
    const accepted = await confirmAuth(
      `Detected ${detection.wired.dependency} — wire auth: ${detection.wired.preset}()?`,
      true,
    );
    if (accepted) return { wired: detection.wired, advice: null };
    if (selectAuth !== undefined) return pickScaffoldAuth(detection, compositionPath, selectAuth);
    return { wired: null, advice: declinedAuthAdvisory(detection.wired, compositionPath) };
  }
  if (detection.matches.length > 1 && selectAuth !== undefined) {
    return pickScaffoldAuth(detection, compositionPath, selectAuth);
  }
  return { wired: null, advice: authAdvisory(detection, compositionPath) };
}
