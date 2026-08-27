import { join } from "node:path";
import type { SelectOption } from "./pretty.js";
import { readOptional } from "./shared.js";

/** The auth families init detects in package.json (09-vendo §2.1). */
export type AuthPresetName = "authJs" | "clerk" | "supabase" | "auth0";

/** Every answer "How do your users sign in?" accepts, which is also every
    `--auth` value. `jwt` and `custom` are wired answers like the four vendor
    presets — both fill the identity seams, oauth half included — and `none` is
    the honest "not yet". */
export type AuthAnswer = AuthPresetName | "jwt" | "custom" | "none";

/** The env variable the scaffolded `jwt({ secret })` reads, and the name init
    writes into `.env.local`. A host-generic JWT scheme has no vendor-owned
    variable to inherit (jwt.ts), so init picks ONE name and both halves — the
    composition line and the env entry — spell it the same way. */
export const JWT_SECRET_ENV = "HOST_API_JWT_SECRET";

/** Each preset function ships on its own subpath — not `@vendoai/vendo/server`
    — so importing one preset never resolves the others' optional peer deps
    (corpus-triage Task 9: a shared barrel meant ANY host importing the server
    entry statically re-resolved every preset's optional peer, e.g. @auth/core,
    even unused). Scaffolded code imports the preset from here and
    createVendo/nextVendoHandler from "@vendoai/vendo/server" separately. */
export const AUTH_PRESET_SPECIFIER: Record<AuthPresetName | "jwt", string> = {
  authJs: "@vendoai/vendo/auth/auth-js",
  clerk: "@vendoai/vendo/auth/clerk",
  supabase: "@vendoai/vendo/auth/supabase",
  auth0: "@vendoai/vendo/auth/auth0",
  jwt: "@vendoai/vendo/auth/jwt",
};

/** What a composition ALREADY on disk wires into the `auth`/`oauth` seams, or
 *  null.
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
 *  agent-loop arm hoists so its exported resolver shares the instance.
 *
 *  `jwt()` counts: it composes through the same `composeHostAuthPreset` every
 *  vendor preset does (identity.ts:228-246), so it carries the oauth half too.
 *  So does a hand-written seam — `oauth` is the DOOR's own config key, so its
 *  presence in the composition is the wiring, whatever the object is called. */
export async function composedAuthPreset(
  compositionPath: string,
): Promise<AuthPresetName | "jwt" | "custom" | null> {
  const source = await readOptional(compositionPath);
  if (source === null) return null;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const presets = Object.keys(AUTH_PRESET_SPECIFIER) as Array<AuthPresetName | "jwt">;
  const preset = presets.find((name) => {
    const subpath = AUTH_PRESET_SPECIFIER[name].replace("@vendoai/vendo", "");
    return new RegExp(`["'](?:@vendoai/vendo|vendoai)${subpath}["']`).test(code)
      && new RegExp(`\\bauth\\s*[:=]\\s*${name}\\s*\\(`).test(code);
  });
  if (preset !== undefined) return preset;
  return /\boauth\s*:/.test(code) ? "custom" : null;
}

/** One auth family the package.json scan found. */
export interface AuthMatch {
  preset: AuthPresetName;
  dependency: string;
  /** A version-shaped caveat the wiring paths must surface (today: next-auth
      v4, whose sessions the v5-speaking authJs() preset cannot read). */
  advisory?: string;
}

/** What the auth answer WIRES, in the shape the scaffolds render: one of the
    four vendor presets (with the dependency detection cited it, where it was
    detected rather than chosen), the host's own JWT scheme, or the seam init
    writes for a host that has none of the above. */
export type AuthWire =
  | { kind: "preset"; preset: AuthPresetName; dependency?: string }
  | { kind: "jwt" }
  | { kind: "custom" };

export interface AuthDetection {
  /** Exactly one family matched — the answer the question pre-selects, and the
      one an unwatched run takes without asking. */
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

/** Auth-preset detection from the host's package.json: one unambiguous family
    becomes the pre-selected answer; none or several leave the question with no
    honest default (`scannedAuthDefault`) and, where nothing is chosen, one
    advisory line. */
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

/** The chose-nothing advisory when a family WAS detected: anonymous
    composition, exact line in hand. */
export function declinedAuthAdvisory(match: AuthMatch, compositionPath: string): string {
  return `Auth: left anonymous. To wire ${match.dependency} later, add one line in ${compositionPath}: auth: ${match.preset}().`;
}

export type SelectAuth = (question: string, options: SelectOption[], defaultIndex?: number) => Promise<string>;

/** Display name + the runtime package each vendor preset lazy-loads (the
    install hint when the chosen family's SDK is absent; the preset's own
    lazy-load error already guards runtime). Key order is the answer order. */
export const AUTH_FAMILY_INFO: Record<AuthPresetName, { name: string; runtime: string }> = {
  authJs: { name: "Auth.js", runtime: "@auth/core" },
  clerk: { name: "Clerk", runtime: "@clerk/backend" },
  supabase: { name: "Supabase Auth", runtime: "jose" },
  auth0: { name: "Auth0", runtime: "jose" },
};

/** The one auth question, asked on EVERY interactive run. It asks about the
    host's users, not about Vendo's mechanism, because "which auth should Vendo
    wire?" is only answerable by someone who already knows what Vendo wires. */
export const AUTH_QUESTION = "How do your users sign in?";

/** The answers, in one fixed order. Detection moves the CURSOR (see
    `scannedAuthDefault`), never the order — a list that reshuffles per host is
    a list nobody learns — and rides along as the hint on the row it found. */
export function authAnswerOptions(detection: AuthDetection): SelectOption[] {
  const presets = (Object.keys(AUTH_FAMILY_INFO) as AuthPresetName[]).map((preset) => {
    const match = detection.matches.find((candidate) => candidate.preset === preset);
    return {
      value: preset,
      label: AUTH_FAMILY_INFO[preset].name,
      ...(match === undefined ? {} : { hint: `detected ${match.dependency}` }),
    };
  });
  return [
    ...presets,
    { value: "jwt", label: "JWT", hint: `your API's own signed tokens, verified with ${JWT_SECRET_ENV}` },
    { value: "custom", label: "Write my own", hint: "a working seam you replace" },
    { value: "none", label: "None yet", hint: "the agent acts with no signed-in user" },
  ];
}

/** The answer the cursor starts on — and, verbatim, the answer a run nobody is
    watching takes. Exactly one family in package.json is a default worth
    pre-selecting; anything else (several families, or none) has no honest
    guess, so it lands on "None yet" — the same anonymous composition
    non-interactive runs have always written. */
export function scannedAuthDefault(detection: AuthDetection): AuthAnswer {
  return detection.wired?.preset ?? "none";
}

const ANSWERS: readonly AuthAnswer[] = ["authJs", "clerk", "supabase", "auth0", "jwt", "custom", "none"];

/** What one answer wires, and the one advisory line (if any) it owes. */
export function wireAuthAnswer(
  detection: AuthDetection,
  compositionPath: string,
  answer: AuthAnswer,
): { wired: AuthWire | null; advice: string | null } {
  if (answer === "jwt") {
    return {
      wired: { kind: "jwt" },
      advice: `Auth: jwt() wired — it verifies your API's own HS256 bearer tokens with ${JWT_SECRET_ENV}, ` +
        `which init added to .env.local. Paste the secret your API signs those tokens with; until you do, ` +
        "every session resolves as anonymous. Claim mapping and options: https://docs.vendo.run/howto/auth.",
    };
  }
  if (answer === "custom") {
    return {
      wired: { kind: "custom" },
      advice: `Auth: your own seam scaffolded in ${compositionPath} — it boots as written, and every caller ` +
        "is the SAME fixed dev subject until you replace both bodies with your real session lookup. " +
        "The seams and their contracts: https://docs.vendo.run/howto/auth.",
    };
  }
  if (answer === "none") {
    return detection.wired !== null
      ? { wired: null, advice: declinedAuthAdvisory(detection.wired, compositionPath) }
      : { wired: null, advice: authAdvisory(detection, compositionPath) };
  }
  const detected = detection.matches.find((match) => match.preset === answer);
  if (detected !== undefined) {
    return {
      wired: { kind: "preset", preset: answer, dependency: detected.dependency },
      advice: detected.advisory ?? null,
    };
  }
  // Chosen without its SDK in package.json: wire it exactly like a
  // detection-accept, plus one install hint.
  const info = AUTH_FAMILY_INFO[answer];
  return {
    wired: { kind: "preset", preset: answer },
    advice: `Auth: ${answer}() wired — ${info.runtime} is not in package.json yet; install it ` +
      `(npm install ${info.runtime}) before the first authenticated run (the preset fails loud until then).`,
  };
}

/** Scan, then ASK — always, on every interactive run that creates the
 *  composition. The scan no longer decides in silence for someone who is
 *  sitting there: it pre-selects, so the one-family host still answers with
 *  Enter, and the ambiguous and empty hosts get the SAME question instead of
 *  an anonymous composition they never chose.
 *
 *  Without the seam — non-interactive, no TTY, CI, `--yes`, `--agent` — the
 *  scanned default is taken SILENTLY. A run nobody is watching must never hang
 *  on a question, and that answer is exactly the one the cursor sits on.
 */
export async function resolveScaffoldAuth(
  root: string,
  compositionPath: string,
  authAnswer: AuthAnswer | undefined,
  selectAuth: SelectAuth | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<{ wired: AuthWire | null; advice: string | null }> {
  const detection = await detectAuthPreset(root, env);
  // --auth answers the question without asking it, and wires identically.
  if (authAnswer !== undefined) return wireAuthAnswer(detection, compositionPath, authAnswer);
  const fallback = scannedAuthDefault(detection);
  if (selectAuth === undefined) return wireAuthAnswer(detection, compositionPath, fallback);
  const options = authAnswerOptions(detection);
  const picked = await selectAuth(AUTH_QUESTION, options, options.findIndex((option) => option.value === fallback));
  return wireAuthAnswer(
    detection,
    compositionPath,
    (ANSWERS as readonly string[]).includes(picked) ? picked as AuthAnswer : fallback,
  );
}
