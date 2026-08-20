import { join } from "node:path";
import type { SelectOption } from "./pretty.js";
import { readOptional } from "./shared.js";

/** The auth families init detects in package.json (09-vendo §2.1). */
export type AuthPresetName = "authJs" | "clerk" | "supabase" | "auth0";

/** Each zero-arg preset function ships on its own subpath — not
    `@vendoai/vendo/server` — so importing one preset never resolves the
    others' optional peer deps (corpus-triage Task 9: a shared barrel meant
    ANY host importing the server entry statically re-resolved every
    preset's optional peer, e.g. @auth/core, even unused). Scaffolded code
    imports the preset from here and createVendo/nextVendoHandler from
    "@vendoai/vendo/server" separately. */
export const AUTH_PRESET_SPECIFIER: Record<AuthPresetName, string> = {
  authJs: "@vendoai/vendo/auth/auth-js",
  clerk: "@vendoai/vendo/auth/clerk",
  supabase: "@vendoai/vendo/auth/supabase",
  auth0: "@vendoai/vendo/auth/auth0",
};

/** The oauth-carrying preset a composition ALREADY on disk wires, or null.
 *
 *  Read from the file's own source, because a re-run over an existing
 *  composition never asks the auth question — so the run's `authWired` is null
 *  even for a host whose `lib/vendo.ts` says `auth: authJs()`, and the MCP
 *  planner used to refuse such a host with "wire an auth preset".
 *
 *  Both spellings of each preset's subpath (an aliased host is wired too),
 *  comments stripped like every other source probe here, and the call has to be
 *  there as well — an import on its own is not a wiring. Either spelling of the
 *  call counts: `auth: preset()` inline, or the `const auth = preset()` the
 *  agent-loop arm hoists so its exported resolver shares the instance. `jwt()`
 *  and an anonymous composition carry no oauth half, so neither is an answer. */
export async function composedAuthPreset(compositionPath: string): Promise<AuthPresetName | null> {
  const source = await readOptional(compositionPath);
  if (source === null) return null;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const presets = Object.keys(AUTH_PRESET_SPECIFIER) as AuthPresetName[];
  return presets.find((preset) => {
    const subpath = AUTH_PRESET_SPECIFIER[preset].replace("@vendoai/vendo", "");
    return new RegExp(`["'](?:@vendoai/vendo|vendoai)${subpath}["']`).test(code)
      && new RegExp(`\\bauth\\s*[:=]\\s*${preset}\\s*\\(`).test(code);
  }) ?? null;
}

export interface AuthMatch {
  preset: AuthPresetName;
  dependency: string;
  /** How the family was chosen: detection (default) cites the dependency it
      found; a picker pick says so honestly — nothing was detected. */
  source?: "picked";
  /** A version-shaped caveat the wiring paths must surface (today: next-auth
      v4, whose sessions the v5-speaking authJs() preset cannot read). */
  advisory?: string;
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

/** The leading major of a semver-ish range ("^4.24.11" → 4, ">=5.0.0-beta" →
    5); undefined for ranges that name no version (workspace:, catalog:,
    latest, tags) — no advisory beats a wrong one. */
function rangeMajor(range: string | undefined): number | undefined {
  if (range === undefined) return undefined;
  const match = /^\s*[~^]?[><=\s]*v?(\d+)/.exec(range);
  return match === null ? undefined : Number(match[1]);
}

/** One of two caveats detection can attach: next-auth v4 wired to the
    v5-speaking authJs() preset. Wiring proceeds (the composition is correct
    for a future v5 upgrade) but the consequences are named, not discovered. */
function nextAuthV4Advisory(range: string): string {
  return `Auth: next-auth v4 detected (${range}) — authJs() speaks Auth.js v5. On v4, signed-in users ` +
    "resolve as anonymous (v4 session cookies are not readable) and away runs cannot be verified by the " +
    "host. Wiring authJs() anyway for a future v5 upgrade; to stay anonymous instead, pass --auth none. " +
    "Details: docs/act-as-presets.md.";
}

const SUPABASE_SERVER_ENV = ["SUPABASE_JWT_SECRET", "SUPABASE_URL"] as const;
const CLERK_SERVER_ENV = ["CLERK_SECRET_KEY", "CLERK_JWT_KEY"] as const;

/** Env files a Next/Node host actually loads in development, checked in the
    same spirit the login flow writes `.env.local`: presence anywhere counts. */
const HOST_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

/** True when any of the names is in the process env or any host env file —
    the one satisfaction rule every preset-env advisory and doctor check
    shares, so init and doctor can never disagree about the same host. */
async function serverEnvSatisfied(
  root: string,
  env: Record<string, string | undefined>,
  names: readonly string[],
): Promise<boolean> {
  if (names.some((name) => Boolean(env[name]))) return true;
  for (const file of HOST_ENV_FILES) {
    const body = await readOptional(join(root, file));
    if (body !== null && names.some((name) => new RegExp(`^\\s*${name}\\s*=`, "m").test(body))) {
      return true;
    }
  }
  return false;
}

export async function supabaseServerEnvSatisfied(
  root: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  return serverEnvSatisfied(root, env, SUPABASE_SERVER_ENV);
}

export async function clerkServerEnvSatisfied(
  root: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  return serverEnvSatisfied(root, env, CLERK_SERVER_ENV);
}

/** The wire's own remediation copy, verbatim-adjacent: doctor and the first
    failing turn teach the same fix. */
export const SUPABASE_ENV_GUIDANCE =
  "supabase() verifies sessions with SUPABASE_JWT_SECRET (HS256, offline) and/or " +
  "SUPABASE_URL (ES256 via GoTrue's JWKS) — server-side names, not the NEXT_PUBLIC_* pair.";

/** Same shape for clerk — and the same wording the keyless wire warns with
    (#1338): the preset reads server-side keys, not the publishable key
    detection saw. */
export const CLERK_ENV_GUIDANCE =
  "clerk() verifies sessions with CLERK_SECRET_KEY (mirroring Clerk's own SDKs) and/or " +
  "CLERK_JWT_KEY (the instance's PEM public key, networkless) — server-side keys, not the NEXT_PUBLIC_* publishable key.";

/** The second caveat, per preset: a family detected from its CLIENT-side
    dependency verifies sessions with SERVER-side env the detection never saw —
    the host wires cleanly and then signed-in turns misbehave (supabase fails
    loud, ENG-422; clerk resolves signed-in users as anonymous, #1338).
    Attached only when no name is in the process env or any host env file; a
    present name means the host already knows. */
async function supabaseEnvAdvisory(
  root: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (await supabaseServerEnvSatisfied(root, env)) return undefined;
  return `Auth: ${SUPABASE_ENV_GUIDANCE} ` +
    "Neither is set; add one to .env.local before the first signed-in turn (the wire fails loud until then).";
}

async function clerkEnvAdvisory(
  root: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (await clerkServerEnvSatisfied(root, env)) return undefined;
  return `Auth: ${CLERK_ENV_GUIDANCE} ` +
    "Neither is set; add one to .env.local — signed-in users resolve as anonymous until then.";
}

/** The env advisories detection attaches post-hoc, one per family that has a
    server-side half detection cannot see. */
const ENV_ADVISORIES = [
  { preset: "supabase", advisory: supabaseEnvAdvisory },
  { preset: "clerk", advisory: clerkEnvAdvisory },
] as const;

/** Silent auth-preset detection from the host's package.json (zero-question
    contract): one unambiguous family gets wired; none or several stay
    anonymous and become one advisory line (detection-as-advice). */
export async function detectAuthPreset(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AuthDetection> {
  let dependencies: string[] = [];
  let versions: Record<string, string> = {};
  try {
    const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    versions = { ...manifest.devDependencies, ...manifest.dependencies };
    dependencies = Object.keys(versions);
  } catch {
    // No readable manifest — nothing to detect; anonymous is the safe default.
  }
  const matches = AUTH_FAMILIES.flatMap(({ preset, test }) => {
    const dependency = dependencies.find(test);
    if (dependency === undefined) return [];
    const advisory = preset === "authJs" && dependency === "next-auth" && rangeMajor(versions[dependency]) === 4
      ? nextAuthV4Advisory(versions[dependency]!)
      : undefined;
    return [{ preset, dependency, ...(advisory === undefined ? {} : { advisory }) }];
  });
  for (const { preset, advisory: envAdvisory } of ENV_ADVISORIES) {
    const match = matches.find((candidate) => candidate.preset === preset);
    if (match !== undefined && match.advisory === undefined) {
      const advisory = await envAdvisory(root, env);
      if (advisory !== undefined) match.advisory = advisory;
    }
  }
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
        "Options and the claim mapping: https://docs.vendo.run/production/auth.",
    };
  }
  const detectedMatch = detected.find((match) => match.preset === picked);
  if (detectedMatch !== undefined) return { wired: detectedMatch, advice: detectedMatch.advisory ?? null };
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
  env: Record<string, string | undefined> = process.env,
): Promise<{ wired: AuthMatch | null; advice: string | null }> {
  const detection = await detectAuthPreset(root, env);
  // --auth answers the confirm AND the picker in one flag: route it through
  // the picker path so a flag answer and an interactive pick wire identically
  // (detection-accept, install hint, jwt recipe, none advisory).
  if (authAnswer !== undefined) {
    return pickScaffoldAuth(detection, compositionPath, async () => authAnswer);
  }
  if (confirmAuth === undefined) {
    return {
      wired: detection.wired,
      advice: detection.wired?.advisory ?? authAdvisory(detection, compositionPath),
    };
  }
  if (detection.wired !== null) {
    // The mechanism (`wire auth: clerk()`) is what happens; what is being
    // DECIDED is whether the agent acts as the person at the keyboard or as a
    // stand-in. Same default, same picker fall-through — the question just
    // says what it means. The scaffold comment carries the mechanism.
    const accepted = await confirmAuth(
      `Should the agent act as your signed-in ${AUTH_FAMILY_INFO[detection.wired.preset].name} user?`,
      true,
    );
    if (accepted) return { wired: detection.wired, advice: detection.wired.advisory ?? null };
    if (selectAuth !== undefined) return pickScaffoldAuth(detection, compositionPath, selectAuth);
    return { wired: null, advice: declinedAuthAdvisory(detection.wired, compositionPath) };
  }
  if (detection.matches.length > 1 && selectAuth !== undefined) {
    return pickScaffoldAuth(detection, compositionPath, selectAuth);
  }
  return { wired: null, advice: authAdvisory(detection, compositionPath) };
}
