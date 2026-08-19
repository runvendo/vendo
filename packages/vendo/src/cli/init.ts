import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isVendoError, VendoError } from "@vendoai/core";
import { stdin, stdout } from "node:process";
import { scrubErrorDetail, type Telemetry } from "@vendoai/telemetry";
import { detectDepVersions, installedAiVersion } from "./dep-versions.js";
import { ensureEnvLocalIgnored, runCloudStep, upsertEnvLocal, type CloudStepOptions } from "./cloud-init.js";
import type { InitPolishSeam } from "./init-judgment.js";
import { BROKER_NEEDS_HTTPS, planMcp, SERVICE_KEY_ON_BROKER, wellFormedServiceKey, type McpPosture } from "./init-mcp.js";
import { initQuestions } from "./init-questions.js";
import { readEnvFiles, rendererFlowOptions, resolveJudgmentConsent, runSyncFlow, writeFonts, type SyncFlowResult } from "./sync-flow.js";
import { BRIEF_TEMPLATE } from "./extract/stages.js";
import { ENV_KEY_VARS, resolveDevCredential, describeDevCredential, type DevCredential } from "../dev-creds/resolve.js";
import { NEXT_SERVER_EXTERNALS, NEXT_SERVER_EXTERNALS_LINE, SERVER_EXTERNALS_ARRAY, blankComments, detectAgentLoopRoute, detectFramework, detectVendoWiring, missingServerExternals, nextConfigPath, transpiledServerExternals, workspaceHostCandidates, type HostFramework } from "./framework.js";
import {
  AUTH_FAMILY_INFO,
  composedAuthPreset,
  detectAuthPreset,
  resolveScaffoldAuth,
  type AuthMatch,
  type AuthPresetName,
  type ConfirmAuth,
  type SelectAuth,
} from "./init-auth.js";
import { aiBelowPeerFloor, ensureGeneratedImports, ensureProviderDeps, ensureVendoPackage, ensureZodFloor, type InstallRunner } from "./provider-deps.js";
import {
  compositionModulePath,
  compositionModuleSource,
  compositionSpecifier,
  customServerSource,
  devBaseUrl,
  devPort,
  expressServerSource,
  importsGeneratedMap,
  requiredServerActions,
  routeSource,
  serverActionsModuleSource,
  serverActionsWiring,
  vendoEnvExample,
  type ScaffoldModel,
} from "./init-scaffolds.js";
import { INIT_USE_CASES, readModelKey, readUseCase, writeInstallRecord, type InitUseCase } from "./install-record.js";
import { createPrettyOutput, plainSecret, plainSelect, plainText, usePrettyOutput, type PrettyOutput, type SelectOption } from "./pretty.js";
import { contrastingText } from "./theme/color.js";
import { themeFontFamilies } from "./theme/embed-fonts.js";
import {
  applyThemeDraft,
  applyThemeFonts,
  toVendoTheme,
  validateSlotValue,
  type ThemeSlotValues,
  type ThemeSummary,
} from "./theme/extract-theme.js";
import {
  appDirectory,
  askYesNo,
  cloudProjectProps,
  consoleOutput,
  detectPackageManager,
  envFileValueSync,
  errorClass,
  exists,
  invokedByPackageScript,
  readOptional,
  toolingTelemetry,
  type Output,
  writeText,
} from "./shared.js";

/**
 * `vendo init` (install-dx v1, re-derived 2026-07-18): one command, the
 * up-front questions, no ceremony.
 *
 *   scan → ask → wire (the server surface — the composition module
 *   `lib/vendo.ts` and the catch-all handler over it; init never writes a
 *   client file; plus package.json hooks) → key (env stated, else the cloud
 *   starter offer) → facts.
 *
 * INIT ONLY EVER CREATES FILES IN YOUR SOURCE TREE (locked DX law). Everything
 * above is a NEW Vendo-owned file, or Vendo-owned config: `package.json`'s two
 * sync hooks, and one idempotent append of `VENDO_BASE_URL` to `.env.example`
 * (the only pre-existing host-authored file init still writes, and it appends
 * — it never rewrites a line). A source file that already exists is never
 * written at all, however stale: mounting the visible surface in the host's own
 * layout, wiring `serverActions` into a route that predates the host's actions,
 * refreshing a stale registration map. `vendo doctor` grades every one of them
 * (E-WIRE-004, E-WIRE-009) and each code's page carries the fix.
 *
 * IT PRINTS NO CODE AND NO STEPS. Every snippet it used to print — the mount
 * paste, the loop wiring, the MCP steps — was a second copy of something the
 * docs already carry, and a terminal cannot keep a copy correct. The run ends
 * on facts and ONE URL (`printFacts`); `--agent` gets the same as JSON.
 *
 * Removed by design: the interview, per-diff y/N approvals, the lib/ai.ts
 * scaffold (createVendo's `model` is optional now), remix offers, the
 * encryption-key step, the refine offer (the `vendo refine` command itself is
 * gone — format v3 replaces it with the enrichment pass), the finale ceremony,
 * and the doctor check (doctor is a standalone command, and init's exit code is
 * about init's own work).
 */

const BRIEF_PLACEHOLDER = `${BRIEF_TEMPLATE}\n`;

export { INIT_USE_CASES, type InitUseCase };

/** What the run settled before it writes anything. Everything else buildPlan
    resolves — the changes, the auth facts — rides beside it on that function's
    return, where each has exactly one reader. */
interface InitPlan {
  framework: Exclude<HostFramework, "unknown"> | "custom";
  /** The `.vendo` artifacts every path lays down. */
  writes: string[];
}

/** How the run ENDS, in every mode: what it wired, what it detected, the guard
    posture it left behind, and the ONE page that carries the instructions. */
interface InitFacts {
  /** The install's files, root-relative: what init wrote, plus what an earlier
      init already put there (it is idempotent, so a re-run leaves the same set
      in place). Every entry exists on disk. */
  wrote: string[];
  detected: { framework: string; auth: string; packageManager: string; port: number };
  guardPosture: string;
  continueUrl: string;
  /** Slots the extraction was unsure of and KEPT as extracted. Nothing blocks
      on them: init asks nothing once the question phase is over. */
  keptUncertain: string[];
  /** Loosening proposals the judgment pass held as PENDING. Never applied — a
      loosening needs a human — and never asked about mid-run, so the count is
      a fact the run reports and `vendo sync --review` is where it is answered. */
  pendingLoosenings: number;
}

/** How an agent-mode run ENDS: the same facts, as data. Its twin is
    `InitQuestions` — one status field tells them apart, and both exit 0, so the
    coding agent branches on the shape and never on a code. */
export interface InitReceipt extends InitFacts {
  status: "written";
  root: string;
  useCase: InitUseCase;
  /** MCP re-run only: the service key is in `.env.local`, but `serviceAuth` is
      not in the composition — init never rewrites a file it did not author, so
      that one line is the developer's, at the continue URL. */
  serviceAuthUnwired?: true;
  /** Agent mode grades like every other run — `graded` means the pass ran here
      and the grades are on disk. `delegated` is the one fallback left: no
      judgment engine resolved on this machine, so the catalog is ungraded and
      the checklist is REQUIRED work for the caller, not a suggestion. */
  judgment:
    | { status: "graded"; file: string }
    | { status: "delegated"; checklist: string[] };
}

/** The one guard fact a fresh install owes its reader. TRUE by construction:
    the policy init writes matches destructive→ask and read→run, and `write` hits
    no rule, so the guard's own default posture runs it (packages/guard
    guard.ts's `#defaultPosture`, which only withholds ungraded + destructive). */
const GUARD_POSTURE = "writes run without approval — how to tighten: vendo.run/agents.md";

/** Where each install continues. ONE page per answer — the terminal states what
    it wired and the docs carry every instruction, because a snippet printed at a
    terminal is a copy nobody can keep correct. */
const CONTINUE_URLS: Record<InitUseCase, string> = {
  embedded: "https://docs.vendo.run/product/quickstart",
  "agent-loop": "https://docs.vendo.run/existing-agent/ai-sdk",
  mcp: "https://docs.vendo.run/outside-agents/quickstart",
};

const JUDGMENT_CHECKLIST = [
  "task-quality descriptions per tool",
  "risk grades into .vendo/overrides.json",
  "replace the .vendo/brief.md placeholder",
  "fill unresolved slots in .vendo/theme.json",
];

export interface InitOptions {
  targetDir: string;
  agent?: boolean;
  yes?: boolean;
  force?: boolean;
  /** Agent-install-dx value flags: each one answers exactly one wizard
      question, so a non-interactive run never needs the prompt it replaces. */
  /** --auth: the auth answer — wires like the equivalent interactive pick. */
  auth?: AuthPresetName | "jwt" | "none";
  /** --framework: detection override; required non-interactively when
      detection comes back "unknown" (there is no safe default to guess).
      "unknown" is excluded: an override that answers nothing would silently
      bypass the non-interactive framework guard. */
  framework?: Exclude<HostFramework, "unknown"> | "custom";
  /** --cloud-key: answer the cloud-login offer with an existing key — landed
      in .env.local exactly where the mint would put it. */
  cloudKey?: string;
  /** --byo: answer the cloud-login offer with "no — bring my own key". */
  byo?: boolean;
  /** --use-case: answer the first question without asking. Unattended runs
      take "embedded" — today's behaviour, so no existing script changes. */
  useCase?: InitUseCase;
  /** --base-url: answer "where does this app run in dev?" without asking —
      written to .env.local as VENDO_BASE_URL. A DEPLOYED URL does not belong
      here: production reads the variable from the hosting platform's own env,
      and a public URL in .env.local would repoint local dev's discovery,
      callbacks and credential forwarding at the deployed origin. */
  baseUrl?: string;
  /** --posture: how outside agents sign in (MCP use case only). */
  posture?: McpPosture;
  /** --service-key: set up a machine-to-machine key (MCP use case only). */
  serviceKey?: boolean;
  /** --ai / --no-ai (`--ai-polish` is the legacy spelling of `--ai`): `true`
      runs the judgment pass with no prompt, `false` forces it off, and
      `undefined` asks in an interactive run and skips otherwise. No answer is
      ever persisted — every interactive run asks again. */
  ai?: boolean;
  /** --engine: pin the AI-polish rung family (claude | codex | npx). */
  engine?: string;
  /** --theme slot=value answers for the uncertain-slot review. */
  themeAnswers?: Record<string, string>;
  output?: Output;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
  env?: Record<string, string | undefined>;
  /** Test seam: credential detection for the key step. */
  resolveCredential?: (options: { env: Record<string, string | undefined> }) => Promise<DevCredential>;
  /** Test seam: the provider-dependency install subprocess (provider-deps.ts). */
  installProvider?: InstallRunner;
  /** Test seam: the `@vendoai/vendo` install subprocess (#1153). */
  installVendo?: InstallRunner;
  /** Test seam: the zod-floor bump install subprocess. */
  installZod?: InstallRunner;
  /** Test seam (ENG-339): cloud-in-init step overrides. */
  cloud?: Partial<Omit<CloudStepOptions, "root" | "output" | "yes" | "credential">>;
  /** Test seam: judgment step overrides (harnesses, consent). */
  extract?: InitPolishSeam;
  /** Test seam: the detect+confirm auth question, asked only in interactive
      runs when exactly one auth family is detected and init is creating the
      composition — and the MCP service-key confirm, which has the same shape.
      Mirrors the AI-polish consent's confirm shape. */
  confirmAuth?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the auth picker shown when the confirm is declined or when
      several families are detected. Receives the choice list (value/label/
      hint) and resolves the chosen value. */
  selectAuth?: (question: string, options: SelectOption[]) => Promise<string>;
  /** Test seam: interactivity override for the auth confirm (default: TTY),
      mirroring the judgment step's `interactive`. */
  interactive?: boolean;
  /** Test seam: the use-case question, and the MCP posture select that hangs
      off it. Mirrors the auth picker's shape. */
  selectUseCase?: (question: string, options: SelectOption[]) => Promise<string>;
  /** Test seam: the free-text asks (the dev base URL). "" is "nobody was
      asked" — the prompt itself turns a bare Enter into the prefilled default,
      so a seam that answers "" stands for a run that never got to ask. */
  askText?: (question: string, hint?: string, defaultValue?: string) => Promise<string>;
}

const THEME_PALETTE_SLOTS = ["accent", "background", "surface", "text", "mutedText", "border", "danger"] as const;

/** One-glance confirm (§B2): the extracted palette, where each slot came
    from is visible in defaulted/errors, and theme.json stays the editable
    source of truth. One emission, plain — the renderer's `Theme:` rule turns
    it into the ◆ block. Nothing here may carry colour: an ANSI swatch written
    at this layer is exactly the escape that leaked under NO_COLOR. */
function printThemeSummary(summary: ThemeSummary, output: Output): void {
  const headings = summary.slots.headingFamily === summary.slots.fontFamily
    ? ""
    : ` · headings ${summary.slots.headingFamily}`;
  const palette = THEME_PALETTE_SLOTS
    .map((slot) => `${slot} ${summary.slots[slot]}`)
    .join(" · ");
  output.log(`Theme: ${palette}`);
  output.log(`Type: ${summary.slots.fontFamily}${headings} · radius ${summary.slots.radius}`);
  const missing = summary.defaulted.filter((slot) =>
    (THEME_PALETTE_SLOTS as readonly string[]).includes(slot) || slot === "fontFamily");
  if (missing.length > 0) {
    output.log(`No host evidence for ${missing.join(", ")} — neutral defaults used.`);
  }
  for (const error of summary.errors) output.error(`warning: ${error}`);
  output.log("Theme lives in .vendo/theme.json — edit it anytime; it is the source of truth.");
}

/** The framework the run scaffolds for. "unknown" detection lands on the
    runtime-neutral custom scaffold — the safe default that exists now
    (guessing the Next layout into a Worker host was the field failure). */
async function resolveFramework(
  root: string,
  options: InitOptions,
): Promise<Exclude<HostFramework, "unknown"> | "custom"> {
  const detected = options.framework ?? await detectFramework(root);
  return detected === "unknown" ? "custom" : detected;
}

const FRAMEWORK_NAMES: Record<Exclude<HostFramework, "unknown"> | "custom", string> = {
  next: "Next.js",
  express: "Express",
  custom: "Custom runtime",
};

/** The detection read-back, printed before the first question. Nothing here
    is newly computed — framework, router style, language, package manager and
    auth family are all detected today and none of them is ever shown, so the
    first thing the user sees is a question about a package they were never
    told we found. Print, never re-detect. */
export async function stackLines(
  root: string,
  framework: Exclude<HostFramework, "unknown"> | "custom",
): Promise<string[]> {
  const router = await detectRouter(root, framework);
  const auth = await detectAuthPreset(root);
  return [
    [
      FRAMEWORK_NAMES[framework],
      ...(router === "none" ? [] : [router === "app" ? "App Router" : "Pages Router"]),
      await exists(join(root, "tsconfig.json")) ? "TypeScript" : "JavaScript",
      await detectPackageManager(root),
    ].join(" · "),
    ...(auth.matches.length === 0 ? [] : [
      `${auth.matches.map((match) => AUTH_FAMILY_INFO[match.preset].name).join(" / ")} auth `
      + `(${auth.matches.map((match) => match.dependency).join(", ")})`,
    ]),
  ];
}

/** The read-back, before the first question. Owed to EVERY run a human
    watches — the rail is only how it is dressed, and gating on the rail is
    what let a `CI=`/`NO_COLOR` terminal open with a question about an app it
    never said it had read. Detect first, print second: the banner's arrival
    plays over the detection, and the reveal then narrates it — a beat per
    fact, so the wave reads as detection time rather than a burst after it. */
async function printStack(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
}): Promise<void> {
  const { root, options, output, pretty } = input;
  const stack = await stackLines(root, await resolveFramework(root, options));
  if (pretty === null) {
    for (const fact of stack) output.log(fact);
    return;
  }
  const facts = stack.map((text, index) => ({
    beat: index === 0 ? "Detecting your framework…" : index === 1 ? "Checking auth…" : undefined,
    text,
  }));
  await pretty.revealBlock("Your stack", facts, { beat: "Reading your app…" });
}

/** Telemetry `router` enum (init_completed): app | pages | none, from the
    same directory evidence appDirectory rides. Express hosts are "none". */
async function detectRouter(root: string, framework: Exclude<HostFramework, "unknown"> | "custom"): Promise<"app" | "pages" | "none"> {
  if (framework === "next") {
    if (await exists(join(root, "src", "app")) || await exists(join(root, "app"))) return "app";
    if (await exists(join(root, "src", "pages")) || await exists(join(root, "pages"))) return "pages";
  }
  return "none";
}

/** A path for a command the caller will paste into their OWN shell: relative
    to their cwd while it stays inside it, "." when it IS their cwd, else
    absolute. A path relative to init's target root resolves somewhere else
    entirely when the two differ (`vendo init monorepo` from /work must not
    suggest `vendo init apps/web`). Quoted with POSIX single quotes when it
    needs it: nothing expands inside them, while double quotes would still let
    a directory named `$(…)` be substituted by the pasting shell. */
function pastePath(target: string): string {
  const rel = relative(process.cwd(), target);
  if (rel === "") return ".";
  const path = rel.startsWith("..") ? target : rel;
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}


function diff(path: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.trimEnd().split("\n");
  const newLines = after.trimEnd().split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

/** The auto-installed hooks carry `--no-ai` explicitly so they can never
    prompt and never spend: a hook runs on someone's `npm run dev`/`build`,
    which is exactly the run that must stay deterministic. `[hook, the bare
    form earlier inits wrote, the flagged form]`. */
const SYNC_HOOKS = [
  ["predev", "vendo sync", "vendo sync --no-ai"],
  ["prebuild", "vendo sync --strict", "vendo sync --strict --no-ai"],
] as const;

function packageWithSyncHooks(raw: string): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    // A manifest npm itself would refuse deserves one clean sentence, never a
    // raw SyntaxError stack (FINDINGS, linkwarden field test 2026-08-08).
    throw new VendoError(
      "validation",
      `package.json is not valid JSON (${error instanceof Error ? error.message : String(error)}) — fix it and re-run vendo init`,
    );
  }
  const priorScripts = manifest["scripts"];
  const scripts = typeof priorScripts === "object" && priorScripts !== null && !Array.isArray(priorScripts)
    ? priorScripts as Record<string, unknown>
    : {};
  let changed = false;
  const hook = (name: string, bare: string, command: string): void => {
    const prior = scripts[name];
    if (typeof prior !== "string") {
      scripts[name] = command;
      changed = true;
      return;
    }
    const segments = prior.split("&&").map((segment) => segment.trim());
    // Idempotent upgrade of the hookless entry a prior init wrote — and only
    // that exact entry. Any other `vendo sync …` in the script is the user's
    // own call (their flags, their order) and is left alone; a script with no
    // vendo sync at all gets the flagged command prepended.
    if (segments.includes(bare)) {
      scripts[name] = segments.map((segment) => (segment === bare ? command : segment)).join(" && ");
      changed = true;
      return;
    }
    if (segments.some((segment) => segment.startsWith("vendo sync"))) return;
    scripts[name] = `${command} && ${prior}`;
    changed = true;
  };
  for (const [name, bare, command] of SYNC_HOOKS) hook(name, bare, command);
  if (!changed) return null;
  manifest["scripts"] = scripts;

  const detectedIndent = raw.match(/^[\t ]+(?=")/m)?.[0] ?? "  ";
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(manifest, null, detectedIndent)}${trailingNewline}`;
}

interface PlannedChange {
  absolute: string;
  path: string;
  before: string | null;
  after: string;
  diff: string;
}

/** What may sit between an assignment and the config object's `{`: nothing, or
    the one plugin call that wraps it. An arrow or a function body is not a
    config object, and inserting a property into one writes broken code. */
const CONFIG_OBJECT_TAIL = String.raw`\s*[\w.$]*\(?\s*\{`;
const EXPORTED_CONFIG_OBJECT = new RegExp(String.raw`(?:export\s+default|module\.exports\s*=)${CONFIG_OBJECT_TAIL}`);
/** The name a config exports rather than declaring inline, plugin call and all
    (`export default withMDX(nextConfig);`). */
const EXPORTED_CONFIG_NAME = /(?:export\s+default|module\.exports\s*=)[^;{]*?([\w$]+)\)?\s*;?\s*$/m;

/** Where a property may be inserted: just past the `{` of the object this
    config EXPORTS. Takes comment-BLANKED source (see `blankComments`), so a
    commented-out export is never taken for the real one. Anchored on the export,
    so an earlier `const withAnalyzer = require("…")({ … })` is not either. Null
    when the file exports something this cannot read as an object literal — a
    dynamic config is the developer's paste, never a rewrite. */
function configObjectBrace(code: string): number | null {
  const name = EXPORTED_CONFIG_NAME.exec(code)?.[1];
  const opener = name === undefined
    ? EXPORTED_CONFIG_OBJECT
    : new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*(?::[^=;{]*)?=${CONFIG_OBJECT_TAIL}`);
  const match = opener.exec(code);
  return match === null ? null : match.index + match[0].length;
}

/** The next.config a Next host needs, given what it is missing: the names
    spliced into the list it already keeps, or the whole property at the top of
    the object it exports. Null when neither shape is there.

    Every offset is read off the comment-blanked source, which `blankComments`
    keeps the same length as `raw` — so a commented-out list is neither read as
    configuration nor written into, and the edit still lands on the real text. */
function nextConfigWithExternals(raw: string, missing: readonly string[]): string | null {
  const names = missing.map((name) => JSON.stringify(name)).join(", ");
  const code = blankComments(raw);
  const array = SERVER_EXTERNALS_ARRAY.exec(code);
  if (array !== null) {
    // Prepended, so a list written one name per line keeps its own indentation.
    const at = array.index + array[1]!.length;
    const listed = array[2]!;
    return `${raw.slice(0, at)}${names}${listed.trim() === "" ? "" : `,${listed.startsWith("\n") ? "" : " "}`}${raw.slice(at)}`;
  }
  const brace = configObjectBrace(code);
  return brace === null ? null : `${raw.slice(0, brace)}\n  ${NEXT_SERVER_EXTERNALS_LINE}${raw.slice(brace)}`;
}

const NEXT_CONFIG_SCAFFOLD = `const nextConfig = {\n  ${NEXT_SERVER_EXTERNALS_LINE}\n};\n\nexport default nextConfig;\n`;

/** The packaged vendo-setup skill (shipped in the npm tarball next to dist/).
    Resolved relative to this module so src (tests) and dist (published bin)
    agree; a missing file degrades to not offering the skill. */
async function setupSkillSource(): Promise<string | null> {
  try {
    return await readFile(new URL("../../skills/vendo-setup/SKILL.md", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

const EMBEDDED_OPTION: SelectOption = { value: "embedded", label: "Embedded in my app — chat + generated UI" };
const AGENT_LOOP_OPTION: SelectOption = { value: "agent-loop", label: "Through my own agent loop (AI SDK / Mastra)" };
const MCP_OPTION: SelectOption = { value: "mcp", label: "From outside agents over MCP — Claude, ChatGPT, Cursor, or any MCP agent (experimental)" };

/** The choices, recommended one FIRST — index 0 is what the select defaults to,
    so ordering IS the recommendation. A host whose own API already runs an agent
    loop has already made this choice; recommending "embedded" to it sent people
    down a path they then had to undo, while the scanner was meanwhile excluding
    that very route from the catalog. The evidence rides the hint: a
    recommendation whose reason is invisible reads as a guess. */
function useCaseOptions(agentLoopRoute: string | null): SelectOption[] {
  return agentLoopRoute === null
    ? [{ ...EMBEDDED_OPTION, hint: "recommended" }, AGENT_LOOP_OPTION, MCP_OPTION]
    : [
        { ...AGENT_LOOP_OPTION, hint: `recommended — detected an agent loop in ${agentLoopRoute}` },
        EMBEDDED_OPTION,
        MCP_OPTION,
      ];
}

/** The run's FIRST question. Every path shares the same wired route, so a
    wrong pick costs nothing; the right one saves a docs round trip. --yes and
    non-interactive runs take the answer this install already recorded, else
    "embedded" — a re-run must not silently re-answer a question the project
    settled, because doctor now grades against it. (The DEFAULT stays embedded
    even where the loop detection moves the recommendation: an unattended run
    must not change what it writes because a host happens to have a chat route.) */
async function resolveUseCase(input: {
  root: string;
  options: InitOptions;
  pretty: PrettyOutput | null;
  interactive: boolean;
}): Promise<InitUseCase> {
  const { root, options, pretty, interactive } = input;
  if (options.useCase !== undefined) return options.useCase;
  if (options.yes === true || !interactive) return await readUseCase(root) ?? "embedded";
  const select = options.selectUseCase ?? (pretty === null ? plainSelect : pretty.select);
  const picked = await select("How will people use your agent?", useCaseOptions(await detectAgentLoopRoute(root)));
  return (INIT_USE_CASES as readonly string[]).includes(picked) ? picked as InitUseCase : "embedded";
}

/** "Where does this app run in dev?" — prefilled with the port the host's own
 *  `dev` script names, so Enter is the whole interaction, and the answer lands
 *  in .env.local as VENDO_BASE_URL. Own-agent-loop tools, backend processes and
 *  the MCP door never see a wire request, so without it the first tool call
 *  meets "Cannot execute … set VENDO_BASE_URL" instead of working.
 *
 *  A run that cannot ASK writes NOTHING: the prefill is only an answer when a
 *  person accepts it, and a guessed origin is worse than an absent one — unset
 *  in dev still learns the request's own origin, and production fails loud.
 *  Production is told at deploy time, never asked here: a public URL in
 *  .env.local would repoint local dev's discovery, callbacks and credential
 *  forwarding at the deployed origin.
 *
 *  Returns the answer, or null when the run could not ask. */
export async function captureDevBaseUrl(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
}): Promise<string | null> {
  const { root, options, output, pretty } = input;
  // This question's interactivity posture is its OWN, and deliberately looser
  // than the auth confirm's: it asks whether there is a TERMINAL, not whether
  // init was launched by a package script. `invokedByPackageScript()` is in the
  // run-wide `interactive` flag so a `prebuild` hook can never block on a
  // prompt — but npm sets `npm_lifecycle_event` for EVERY `npm run …`, so
  // borrowing that flag here meant a human at a real terminal who launched init
  // through any wrapper script got no question and no VENDO_BASE_URL, while
  // `npx vendo init` (event "npx", excluded) asked and wrote one. That is the
  // conflicting field observation: same terminal, same person, two outcomes.
  //
  // plainText carries plainSelect's guard — a non-TTY input or output returns
  // "" and never prompts — so a piped run stays byte-identical while a NO_COLOR
  // terminal still gets the question. Making this pretty-only would silently
  // delete the feature for anyone who sets NO_COLOR. The test seam sits INSIDE
  // the interactivity gate, like the auth confirm's: a stubbed prompt must not
  // make an unattended run ask what the real one never reaches.
  const attended = options.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  const ask = options.baseUrl !== undefined
    ? async () => options.baseUrl!
    : options.yes === true || options.agent === true || !attended
      ? undefined
      : options.askText ?? (pretty === null ? plainText : pretty.text);
  if (ask === undefined) return null;
  const prefill = devBaseUrl(await devPort(root));
  const url = (await ask("Where does this app run in dev?", `Enter to accept ${prefill}`, prefill)).trim();
  if (url === "") return null;
  await upsertEnvLocal(root, "VENDO_BASE_URL", url);
  output.log(`Wrote VENDO_BASE_URL=${url} to .env.local`);
  await ensureEnvLocalIgnored(root, output);
  return url;
}

/** The footer's stats. It never claims more than the run achieved: the catalog
    it read, the brand it captured, and that the wiring landed. */
export function runStats(input: { toolCount: number; brandCaptured: boolean }): string {
  return [
    `${input.toolCount} tool${input.toolCount === 1 ? "" : "s"}`,
    ...(input.brandCaptured ? ["brand captured"] : []),
    "wired",
  ].join(" · ");
}

/** Does the host declare this package (either dependency block)? */
async function dependsOn(root: string, name: string): Promise<boolean> {
  try {
    const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Object.hasOwn({ ...manifest.dependencies, ...manifest.devDependencies }, name);
  } catch {
    return false;
  }
}

/** The ONE page this install continues at. An agent-loop host is sent to the
    page for the loop package it actually has — read off the same package.json
    everything else here reads. */
async function continueUrl(root: string, useCase: InitUseCase): Promise<string> {
  return useCase === "agent-loop" && await dependsOn(root, "@mastra/core")
    ? "https://docs.vendo.run/existing-agent/mastra"
    : CONTINUE_URLS[useCase];
}

const POSTURE_OPTIONS: SelectOption[] = [
  {
    value: "broker",
    label: "Vendo Cloud broker — keys managed in the console, stable tenant URL, OAuth surface stays off your domain",
    hint: "recommended with your Cloud account",
  },
  { value: "local", label: "Local — your app serves its own OAuth (zero config, fully standard)" },
];

/** Variant C. Init asks two more questions here and then WRITES what it
 *  legitimately owns: it creates the composition file, so putting `mcp: true`
 *  and a serviceAuth key into a file it is authoring is not editing anyone's
 *  code. It never discovers posture and never reaches a broker — the operator's
 *  environment values live on the continue page.
 *
 *  The posture select only appears when the run holds a Cloud key: a keyless
 *  run cannot use a broker, so local is simply the default. */
async function planMcpScaffold(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
  interactive: boolean;
  changes: PlannedChange[];
  framework: Exclude<HostFramework, "unknown"> | "custom";
  authWired: AuthMatch | null;
  cloudKey: boolean;
  models: ScaffoldModel | null;
  /** The dev origin captured with the other up-front questions. The broker
      refusal below is the only thing that still reads it: a Cloud-fronted door
      cannot stand on an http origin. Null when the run could not ask. */
  baseUrl: string | null;
}): Promise<{ modelWritten: ScaffoldPlan["modelWritten"]; serviceAuthUnwired: boolean } | null> {
  const { root, options, output, pretty, interactive, changes, framework, authWired, cloudKey, models, baseUrl } = input;
  const ask = options.yes === true || !interactive;

  let posture: McpPosture = options.posture ?? "local";
  if (options.posture === undefined && cloudKey && !ask) {
    const select = options.selectUseCase ?? (pretty === null ? plainSelect : pretty.select);
    posture = (await select("How should outside agents sign in?", POSTURE_OPTIONS)) as McpPosture;
  }

  // `cli.ts` refuses the flag pair it can read off argv. A posture chosen at
  // the SELECT never reaches argv, so the same mistake arrived here and the key
  // was dropped in silence — the one path where a user could still believe it
  // landed. Same explanation, same way out, one lead-in for each arrival.
  if (options.serviceKey === true && posture === "broker") {
    throw new VendoError("validation", `--service-key does not apply to the broker posture you chose: ${SERVICE_KEY_ON_BROKER}`);
  }
  // The other pair that cannot work, caught HERE because this is the first
  // point where both answers are known: the origin was captured before the
  // posture was asked. Silence cost a live proof a dead door and a `Wired`.
  if (posture === "broker" && baseUrl !== null && !baseUrl.startsWith("https://")) {
    throw new VendoError("validation", `The Vendo Cloud broker cannot front a door at ${baseUrl}: ${BROKER_NEEDS_HTTPS}`);
  }

  // Local doors only. A Cloud-fronted door's service key is provisioned with
  // the tenant and listed, rotated and revoked in the console, so asking here
  // would offer a decision init cannot act on.
  let serviceKey = options.serviceKey === true;
  if (options.serviceKey === undefined && !ask && posture === "local") {
    const confirm = options.confirmAuth ?? (pretty === null ? askYesNo : pretty.confirm);
    serviceKey = await confirm("Will your own backend call these tools machine-to-machine?", false);
  }

  const composition = await compositionModulePath(root);
  const appDir = await appDirectory(root);
  // The key the host already has, so a re-run reuses it instead of rotating the
  // secret every backend caller is exchanging (see McpPlanInput.existingServiceKey).
  const existingServiceKey = envFileValueSync(root, "VENDO_SERVICE_KEY");
  const mcp = planMcp({
    root,
    appDir,
    composition,
    compositionSpecifier: await compositionSpecifier(root, join(appDir, ".well-known", "[...vendo]")),
    framework,
    authWired,
    // A re-run over an existing composition never re-decides auth, so
    // `authWired` is null even where lib/vendo.ts already says `auth: authJs()`
    // — the file itself is the only remaining evidence.
    authAlreadyWired: authWired === null && await composedAuthPreset(composition) !== null,
    serverActions: (await requiredServerActions(root)).length > 0,
    posture,
    serviceKey,
    ...(existingServiceKey === null ? {} : { existingServiceKey }),
    models,
  });
  if (mcp.blocked !== undefined) {
    // Nothing MCP was written and the reason says what to do about it. The
    // rest of the install stands — this is an advisory, not a failure.
    output.error(`warning: ${mcp.blocked}`);
    return null;
  }
  // The composition init is already CREATING gains the door — same file, one
  // more option inside the same createVendo call. The planner cannot know
  // whether that file exists, so it hands back the source and the caller
  // pushes it into the change it already planned; a composition init did not
  // write this run is left alone, as always.
  const planned = changes.find((change) => change.absolute === composition && change.before === null);
  if (planned !== undefined && mcp.compositionSource !== null) {
    planned.after = mcp.compositionSource;
    planned.diff = diff(planned.path, null, mcp.compositionSource);
  }
  // The origin-root discovery route is new.
  for (const change of mcp.changes) {
    if (changes.some((existing) => existing.absolute === change.absolute)) continue;
    changes.push({
      absolute: change.absolute,
      path: change.path,
      before: null,
      after: change.after,
      diff: diff(change.path, null, change.after),
    });
  }
  // A reused key is already where it belongs, so there is nothing to write and
  // nothing to claim: saying "Generated" over an untouched value is what made a
  // re-run read as a rotation.
  if (mcp.serviceKeyValue !== undefined) {
    if (wellFormedServiceKey(existingServiceKey) && mcp.serviceKeyValue === existingServiceKey!.trim()) {
      output.log(`VENDO_SERVICE_KEY already set — reused (…${mcp.serviceKeyValue.slice(-4)})`);
    } else {
      await upsertEnvLocal(root, "VENDO_SERVICE_KEY", mcp.serviceKeyValue);
      output.log(`Generated VENDO_SERVICE_KEY → .env.local (…${mcp.serviceKeyValue.slice(-4)})`);
      await ensureEnvLocalIgnored(root, output);
    }
  }
  return {
    // The models line only counts where the composition was actually written: a
    // re-run against an existing one must not claim a line it left untouched, in
    // a file it did not open.
    modelWritten: planned === undefined ? null : mcp.modelWritten,
    // …and on that same re-run the key is in .env.local while `serviceAuth` is
    // not in the composition. Init never rewrites a file it did not author, so
    // that one line is the developer's — at the continue URL, not here.
    serviceAuthUnwired: planned === undefined && mcp.serviceKeyValue !== undefined,
  };
}

/** What one framework's composition branch contributes to the plan: the files
 *  init will create and the auth facts the run reports. */
interface ScaffoldPlan {
  changes: PlannedChange[];
  authAdvice: string | null;
  authWired: AuthMatch | null;
  compositionPath: string | null;
  /** The provider and file of the `models` line this run wrote — the migration
      path off the removed ambient-key behaviour, and what the closing summary
      reports. Null when no provider line was written. */
  modelWritten: { provider: ScaffoldModel["provider"]; path: string } | null;
  /** Write an explicit `models` line into the composition this run authored.
      The models ANSWER is only settled by the cloud step, which runs after the
      plan is built and before a single file is written, so the line can never be
      resolved at plan time. Returns the modelWritten to report; null when this
      run authored no composition. */
  rewriteModels: ((model: ScaffoldModel) => ScaffoldPlan["modelWritten"]) | null;
}

const emptyScaffold = (): ScaffoldPlan => ({
  changes: [],
  authAdvice: null,
  authWired: null,
  compositionPath: null,
  modelWritten: null,
  rewriteModels: null,
});

async function planCustomComposition(
  root: string,
  options: InitOptions,
  confirmAuth?: ConfirmAuth,
  selectAuth?: SelectAuth,
): Promise<ScaffoldPlan> {
  const scaffold = emptyScaffold();
  const wiring = await detectVendoWiring(root);
  if (!wiring.server || !wiring.client) {
    const typescript = await exists(join(root, "tsconfig.json"));
    const server = join(root, "vendo", typescript ? "server.ts" : "server.mjs");
    const serverBefore = await readOptional(server);
    // Same ownership rule as the Express branch: init composes only when it
    // CREATES the composition.
    const scaffolding = serverBefore === null && !wiring.server;
    if (scaffolding) {
      const path = relative(root, server);
      const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
      const serverAfter = customServerSource(typescript, auth.wired);
      scaffold.changes.push({ absolute: server, path, before: null, after: serverAfter, diff: diff(path, null, serverAfter) });
      scaffold.authAdvice = auth.advice;
      scaffold.authWired = auth.wired;
      scaffold.compositionPath = path;
    }
  }
  return scaffold;
}

async function planExpressComposition(
  root: string,
  options: InitOptions,
  confirmAuth?: ConfirmAuth,
  selectAuth?: SelectAuth,
): Promise<ScaffoldPlan> {
  const scaffold = emptyScaffold();
  const wiring = await detectVendoWiring(root);
  if (!wiring.server || !wiring.client) {
    const typescript = await exists(join(root, "tsconfig.json"));
    const server = join(root, "vendo", typescript ? "server.ts" : "server.mjs");
    const serverBefore = await readOptional(server);
    // Init owns the composition only when it CREATES it: no generated
    // server module yet AND no hand-wired createVendo anywhere else. A host
    // that composed at its own path but hasn't pasted <VendoProvider> yet
    // gets no duplicate server module — the Express analog of the Next
    // branch's routeBefore === null guard.
    const scaffolding = serverBefore === null && !wiring.server;
    if (scaffolding) {
      const path = relative(root, server);
      // Detect + confirm happens only here — fresh composition creation —
      // so a re-run before the manual <VendoProvider> paste neither asks nor
      // re-fires the advisory after "Already wired".
      const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
      const serverAfter = expressServerSource(typescript, auth.wired);
      scaffold.changes.push({ absolute: server, path, before: null, after: serverAfter, diff: diff(path, null, serverAfter) });
      scaffold.authAdvice = auth.advice;
      scaffold.authWired = auth.wired;
      scaffold.compositionPath = path;
    }
  }
  return scaffold;
}

/** The registration map is generated once, when the host's first "use server"
 *  action appears. After that it is the developer's file and is never rewritten
 *  — so an existing one is compared by the KEYS it registers, not byte-for-byte.
 *  Byte-comparing would demand a paste for their own formatting, their own extra
 *  entries, and even a reworded comment in a Vendo release, forever, on a
 *  surface that never moved. */
function planServerActionsMap(
  scaffold: ScaffoldPlan,
  root: string,
  actionsModule: string,
  actionsBefore: string | null,
  registrations: Awaited<ReturnType<typeof requiredServerActions>>,
): void {
  const path = relative(root, actionsModule);
  if (actionsBefore === null) {
    const actionsAfter = serverActionsModuleSource(root, dirname(actionsModule), registrations);
    scaffold.changes.push({ absolute: actionsModule, path, before: null, after: actionsAfter, diff: diff(path, null, actionsAfter) });
    return;
  }
  // Missing entries are NOT init's to add: the map is the developer's file from
  // creation on. Doctor grades the gap (E-WIRE-009) and its page carries the fix.
}

async function planNextComposition(
  root: string,
  options: InitOptions,
  confirmAuth?: ConfirmAuth,
  selectAuth?: SelectAuth,
): Promise<ScaffoldPlan> {
  const scaffold = emptyScaffold();
  const app = await appDirectory(root);
  const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
  const libModule = await compositionModulePath(root);
  const routeBefore = await readOptional(route);
  const libBefore = await readOptional(libModule);
  // WHICH file holds this host's createVendo: the module init writes — creating
  // it now, or from an earlier run — else the route of an older install, which
  // still holds it inline and which init never rewrites.
  const composition = routeBefore === null || libBefore !== null ? libModule : route;
  const compositionBefore = composition === libModule ? libBefore : routeBefore;
  // The map lives NEXT TO the composition that imports it (`./vendo-actions`),
  // wherever that turns out to be.
  const actionsModule = join(dirname(composition), "vendo-actions.ts");
  const actionsBefore = await readOptional(actionsModule);
  const registrations = await requiredServerActions(root);
  // …and the map exists only for a composition that will CONSUME it: the one
  // being created now, one that already imports ./vendo-actions, or one init is
  // about to hand the import paste to. A composition building its own map never
  // grows an orphan — the same rule the registry above follows, and the same
  // shape doctor stays silent about.
  const mapConsumed = compositionBefore === null
    || importsGeneratedMap(compositionBefore)
    || serverActionsWiring(compositionBefore) === "unwired";
  if (registrations.length > 0 && mapConsumed) {
    planServerActionsMap(scaffold, root, actionsModule, actionsBefore, registrations);
  }
  if (routeBefore === null) {
    const routePath = relative(root, route);
    const routeAfter = routeSource(await compositionSpecifier(root, dirname(route)));
    scaffold.changes.push({ absolute: route, path: routePath, before: null, after: routeAfter, diff: diff(routePath, null, routeAfter) });
  }
  if (compositionBefore === null) {
    const path = relative(root, composition);
    // Detect + confirm happens only on fresh composition creation.
    const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
    const render = (model: ScaffoldModel | null): string =>
      compositionModuleSource({ serverActions: registrations.length > 0, auth: auth.wired, models: model });
    const change = { absolute: composition, path, before: null, after: render(null), diff: diff(path, null, render(null)) };
    scaffold.changes.push(change);
    scaffold.authAdvice = auth.advice;
    scaffold.authWired = auth.wired;
    scaffold.compositionPath = path;
    // Same renderer, same arguments, one late model — never a second way to
    // write this line. The change object is still unwritten at this point.
    scaffold.rewriteModels = (model) => {
      change.after = render(model);
      change.diff = diff(path, null, change.after);
      return { provider: model.provider, path };
    };
  }
  return scaffold;
}

async function buildPlan(options: InitOptions, confirmAuth?: ConfirmAuth, selectAuth?: SelectAuth): Promise<{
  plan: InitPlan;
  changes: PlannedChange[];
  authAdvice: string | null;
  /** What the fresh composition wired; null when no composition was created
      this run OR it stayed anonymous. */
  authWired: AuthMatch | null;
  /** Relative path of the composition created THIS run; null otherwise. */
  compositionPath: string | null;
  /** See ScaffoldPlan.rewriteModels — the models answer arrives after this plan. */
  rewriteModels: ScaffoldPlan["rewriteModels"];
}> {
  const root = resolve(options.targetDir);
  // The non-interactive guard still demands an explicit --framework, so
  // agents never inherit resolveFramework's custom fall-through silently.
  const framework = await resolveFramework(root, options);
  const scaffold = framework === "custom"
    ? await planCustomComposition(root, options, confirmAuth, selectAuth)
    : framework === "express"
      ? await planExpressComposition(root, options, confirmAuth, selectAuth)
      : await planNextComposition(root, options, confirmAuth, selectAuth);
  const { changes, authAdvice, authWired, compositionPath, rewriteModels } = scaffold;

  const packageJson = join(root, "package.json");
  const packageBefore = await readOptional(packageJson);
  if (packageBefore !== null) {
    const packageAfter = packageWithSyncHooks(packageBefore);
    if (packageAfter !== null) {
      const path = relative(root, packageJson);
      changes.push({
        absolute: packageJson,
        path,
        before: packageBefore,
        after: packageAfter,
        diff: diff(path, packageBefore, packageAfter),
      });
    }
  }
  // The one Next setting a Vendo install cannot work without (see
  // NEXT_SERVER_EXTERNALS). A config init cannot read as an object literal is
  // the developer's paste, exactly like every other file it did not write.
  if (framework === "next") {
    const found = await nextConfigPath(root);
    const before = found === null ? null : await readOptional(found);
    const missing = before === null ? NEXT_SERVER_EXTERNALS : missingServerExternals(before);
    if (missing.length > 0) {
      const absolute = found ?? join(root, "next.config.mjs");
      const path = relative(root, absolute);
      // A host that TRANSPILES one of these keeps the paste whatever its shape:
      // Next hard-fatals on a package named in both lists, so writing the
      // property for them would brick the dev server this run just wired.
      const conflicting = before === null ? [] : transpiledServerExternals(before);
      const after = conflicting.length > 0
        ? null
        : before === null
          ? NEXT_CONFIG_SCAFFOLD
          : nextConfigWithExternals(before, missing);
      // A config init cannot safely edit is left alone and graded by doctor
      // (E-CFG-004, whose page carries the line and the transpile caveat).
      if (after !== null) changes.push({ absolute, path, before, after, diff: diff(path, before, after) });
    }
  }
  // Agent surface: a host that already uses skills (.claude/ exists) gets the
  // packaged vendo-setup skill. Written only while missing — an edited copy is
  // respected (never overwritten); a deleted copy returns on the next init,
  // like any missing scaffold.
  if (await exists(join(root, ".claude"))) {
    const skillAbsolute = join(root, ".claude", "skills", "vendo-setup", "SKILL.md");
    if (!(await exists(skillAbsolute))) {
      const skillSource = await setupSkillSource();
      if (skillSource !== null) {
        const path = relative(root, skillAbsolute);
        changes.push({ absolute: skillAbsolute, path, before: null, after: skillSource, diff: diff(path, null, skillSource) });
      }
    }
  }
  const writes = [
    ".env.example",
    ".vendo/install.json",
    ".vendo/tools.json",
    ".vendo/overrides.json",
    ".vendo/policy.json",
    ".vendo/brief.md",
    ".vendo/theme.json",
    ".vendo/theme.extracted.json",
    ".vendo/fonts.css",
    ".vendo/data/.gitignore",
  ];
  return { changes, authAdvice, authWired, compositionPath, rewriteModels, plan: { framework, writes } };
}

async function writeIfMissing(path: string, content: string, force: boolean): Promise<void> {
  if (!force && await exists(path)) return;
  await writeText(path, content);
}

async function ensureVendoEnvExample(root: string): Promise<void> {
  const path = join(root, ".env.example");
  const current = await readOptional(path);
  // The host's OWN dev port, off its `dev` script: a placeholder naming :3000
  // to an app served on :4000 is a base URL the developer copies into
  // .env.local and then debugs for an hour.
  const example = vendoEnvExample(await devPort(root));
  if (current === null) {
    await writeText(path, example);
    return;
  }
  if (/^\s*VENDO_BASE_URL\s*=/m.test(current)) return;
  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeText(path, `${current}${separator}${example}`);
}

/** root rides in as the client's cwd: projectIdHash/packageManager and the
    .env.local cloud-key read attribute to the TARGET project, not the shell
    cwd (`vendo init ../app` from elsewhere). Seams in options.telemetry win. */
function telemetryFor(options: InitOptions, output: Output, root: string): Telemetry {
  return toolingTelemetry({ cwd: root, ...options.telemetry, log: (message) => output.log(message) });
}

/** 09-vendo §5 — idempotent, zero-question setup. */
/** Apply the answers a human gave (via `--theme` or the review prompt) over the
 *  extracted/merged summary, in place. Unknown slots and invalid values are
 *  reported and skipped rather than written. */
function applyThemeAnswers(
  summary: ThemeSummary,
  answers: Record<string, string>,
  output: Output,
): void {
  for (const [slot, raw] of Object.entries(answers)) {
    if (!Object.hasOwn(summary.slots, slot)) {
      output.error(`ignored unknown theme slot ${JSON.stringify(slot)}`);
      continue;
    }
    const value = validateSlotValue(slot as keyof ThemeSlotValues, raw);
    if (value === null) {
      output.error(`ignored invalid theme ${slot} value ${JSON.stringify(raw)}`);
    } else {
      (summary.slots as unknown as Record<string, string>)[slot] = value;
      summary.matched[slot] = "(you)";
      // The slot no longer defaulted — the human just set it.
      summary.defaulted = summary.defaulted.filter((name) => name !== slot);
    }
  }
  // A replaced accent invalidates an accentText nobody chose — one that
  // was contrast-derived, or still the neutral default because the
  // model omitted the accent too. Re-derive against the new accent; an
  // explicit token or a direct human/model answer stays authoritative.
  const accentTextUnchosen = summary.matched["accentText"] === "(contrast) accent"
    || summary.defaulted.includes("accentText");
  if (summary.matched["accent"] === "(you)" && accentTextUnchosen) {
    summary.slots.accentText = contrastingText(summary.slots.accent);
    summary.matched["accentText"] = "(contrast) accent";
    summary.defaulted = summary.defaulted.filter((name) => name !== "accentText");
  }
}

/** Theme finalization (Task 4): merge whatever the AI pass filled — if
 *  consent was declined or unavailable, `themeDraft` is simply null and the
 *  exact-only summary stands — then --theme answers (a human "(you)" wins over
 *  a model value), and the one-glance palette print.
 *
 *  It asks NOTHING. This ran after the long AI pass, which is exactly when the
 *  person who started the install has walked away, so a slot the model was
 *  unsure of keeps what was extracted and the run REPORTS the slot instead
 *  (`InitFacts.keptUncertain`). Returns those slot names. */
async function finalizeTheme(input: {
  root: string;
  themeSummary: ThemeSummary;
  themeDraft: SyncFlowResult["themeDraft"];
  themePath: string;
  options: InitOptions;
  output: Output;
}): Promise<string[]> {
  const { root, themeSummary, themeDraft, themePath, options, output } = input;
  const summary = themeDraft === null ? themeSummary : applyThemeDraft(themeSummary, themeDraft);
  const answers: Record<string, string> = { ...(options.themeAnswers ?? {}) };
  const kept = summary.uncertain
    .filter((entry) => !Object.hasOwn(answers, entry.slot))
    .map((entry) => entry.slot);
  if (Object.keys(answers).length > 0) applyThemeAnswers(summary, answers, output);
  const document = toVendoTheme(summary.slots);
  // A model fill or a --theme answer can replace the family AFTER the flow
  // resolved faces from the extracted one, and the host would then SHIP a
  // typeface they overrode. Re-resolve from the document actually being
  // written — and only when the selection really moved, so the ordinary
  // install still embeds exactly once.
  const chose = new Set(themeFontFamilies(document).map((family) => family.toLowerCase()));
  const embedded = new Set((summary.fonts ?? []).map((font) => font.family.toLowerCase()));
  const moved = chose.size !== embedded.size || [...chose].some((family) => !embedded.has(family));
  const fonts = moved
    ? await writeFonts(root, join(root, ".vendo"), document, (message: string) => output.log(message))
    : summary.fonts ?? [];
  applyThemeFonts(document, fonts);
  await writeText(themePath, `${JSON.stringify(document, null, 2)}\n`);
  printThemeSummary(summary, output);
  return kept;
}

/** An undetectable framework has NO safe default: a non-interactive run
 *  (agents) errors with the exact flag instead of guessing the Next layout
 *  into an unknown host. An interactive run keeps today's fall-through to the
 *  custom scaffold — silently wrong when the host is a workspace package one
 *  level down, so name the candidates instead of guessing for them.
 *
 *  Returns false when init must stop with exit 1. */
async function guardUndetectedFramework(input: {
  root: string;
  options: InitOptions;
  output: Output;
  interactive: boolean;
}): Promise<boolean> {
  const { root, options, output, interactive } = input;
  if (options.framework !== undefined || await detectFramework(root) !== "unknown") return true;
  if (options.yes === true || !interactive) {
    output.error(
      "Framework not detected (no next or express dependency in package.json) and this run cannot ask. " +
      "Pass --framework. Examples: vendo init --framework next · --framework custom (any Web-standard runtime: Cloudflare Workers, Bun, Hono, ...)",
    );
    return false;
  }
  const candidates = await workspaceHostCandidates(root);
  if (candidates.length > 0) {
    output.error(
      `warning: no next or express dependency in this directory, but ${candidates.join(", ")} ` +
      `${candidates.length === 1 ? "looks" : "look"} like the host — did you mean ${candidates[0]}? ` +
      `Re-run there (vendo init ${pastePath(join(root, candidates[0]!))}) or pass --framework to scaffold this directory anyway.`,
    );
  }
  return true;
}

/** What an unattended run WOULD settle, one line per still-open question, each
    naming the flag that answers it instead. Written from the SAME question list
    `--agent` relays, so the two can never disagree about what a person owns. */
async function unattendedDefaultLines(input: {
  root: string;
  options: InitOptions;
  questions: readonly { id: string }[];
}): Promise<string[]> {
  const { root, options, questions } = input;
  const lines: string[] = [];
  for (const question of questions) {
    if (question.id === "use-case") {
      // `readUseCase` answers `undefined` for "no record", never null.
      const recorded = await readUseCase(root);
      lines.push(`use case: ${recorded ?? "embedded"}${recorded === undefined ? "" : " (recorded by an earlier init)"} — --use-case ${INIT_USE_CASES.join(" | ")}`);
    } else if (question.id === "auth") {
      const wired = (await detectAuthPreset(root)).wired;
      lines.push(wired === null
        ? "auth: none — every session stays anonymous — --auth clerk | authJs | supabase | auth0 | jwt | none"
        : `auth: ${wired.preset}() (detected ${wired.dependency}) — --auth <preset>, or --auth none`);
    } else if (question.id === "models") {
      lines.push("model key: only what is already in the environment — no login offer, so a keyless host cannot answer one turn — --byo, or --cloud-key <key>");
    } else if (question.id === "dev-url") {
      lines.push(`VENDO_BASE_URL: not written — your own agent loop, any backend process and the MCP door each fail their FIRST tool call without it — --base-url ${devBaseUrl(await devPort(root))}`);
    } else if (question.id === "posture") {
      lines.push("MCP sign-in: local — your app serves its own OAuth — --posture local | broker");
    } else if (question.id === "service-key") {
      lines.push("service key: none minted — --service-key if your backend calls these tools machine-to-machine");
    }
  }
  // Never one of `initQuestions`' relayed questions (it is mechanical, not a
  // person's decision) but it IS a default this run would take in silence.
  if (options.ai === undefined) {
    lines.push("judgment: skipped — every tool stays ungraded, so the agent asks before every single call — --ai");
  }
  return lines;
}

/**
 * A run that CANNOT ask must not answer for the developer.
 *
 * Piped stdin and CI used to settle every question a PERSON owns — the use case
 * doctor then grades against, the auth the agent acts as, the model offer, the
 * dev origin every backend tool call needs — and then print the same success
 * frame an attended install prints. Nothing said a single decision had been made,
 * so the first sign was a tool call failing days later.
 *
 * `--yes` is the explicit "take the defaults" and proceeds — still printing them,
 * because a default nobody was told about is the whole failure mode.
 *
 * Returns false when init must stop with exit 1.
 */
async function guardNonInteractive(input: {
  root: string;
  options: InitOptions;
  output: Output;
  interactive: boolean;
}): Promise<boolean> {
  const { root, options, output, interactive } = input;
  if (interactive) return true;
  const cloudKey = (credentialEnv(root, options.env ?? process.env)["VENDO_API_KEY"] ?? "").trim() !== "";
  const unanswered = await initQuestions({
    root,
    options,
    framework: await resolveFramework(root, options),
    modelKey: cloudKey || providerKey(root, options) !== null,
    cloudKey,
    devPort: await devPort(root),
  });
  if (unanswered === null) return true;
  const defaults = await unattendedDefaultLines({ root, options, questions: unanswered.questions });
  // --yes IS the answer, so the run proceeds — but it still SAYS what it settled.
  // A default nobody was told about is the whole failure mode, flag or no flag.
  if (options.yes === true) {
    output.log("Taking the defaults (--yes):");
    for (const line of defaults) output.log(`  ${line}`);
    return true;
  }
  output.error(
    "vendo init: this run cannot ask (stdin is not a terminal), and answering for you is how a project ends up "
    + "with an install nobody chose. Pass --yes to take the defaults below, or answer them with flags. "
    + "`vendo init --agent` relays the same questions as JSON for a coding agent to ask.",
  );
  output.error("What --yes would settle here:");
  for (const line of defaults) output.error(`  ${line}`);
  return false;
}

/** The source of every CODE file this run created, and only those: a host file
    init merely appended to (package.json, next.config) is not init's import to
    own, and the packaged skill is prose whose fenced examples are not this app's. */
const generatedSources = (changes: readonly PlannedChange[]): string[] =>
  changes
    .filter((change) => change.before === null && /\.[cm]?[jt]sx?$/.test(change.path))
    .map((change) => change.after);

/** What a run with no grades says. `--ai` and never the bare command: this line
 *  is read by the runs that cannot answer a consent prompt (agents, CI), where a
 *  bare `vendo sync` skips the pass again and the advice never lands.
 *
 *  Agent mode always ASKS for the pass now, so an agent reaching here has no
 *  engine on the machine at all — and the caller is a model, so the grading is
 *  its work and the line says so as work, not as background. */
function ungradedLine(agent: boolean): string {
  if (!agent) {
    return "judgment: structural-only — only protocol facts are graded, so every ungraded tool asks on each call"
      + " (add a model key and run `vendo sync --ai` to grade the catalog)";
  }
  return "judgment: REQUIRED, not done — no judgment engine resolved on this machine, so every tool is ungraded and asks on every call."
    + " Install one (`npm install -g @anthropic-ai/claude-code`) and run `vendo sync --ai` to grade the catalog, or grade it yourself:"
    + ` the receipt's judgment.checklist is the work, and grades land in ${join(".vendo", "judgments.json")}`;
}

/** BOTH stop-conditions for a run that would otherwise guess, in one call.
 *
 * Agent mode passes straight through: it keeps the fall-through to the
 * runtime-neutral custom scaffold it has always had (resolveFramework answers
 * "custom" for an undetectable host, which is a safe default rather than a
 * guess), and it relays the person-questions as JSON instead of settling them.
 *
 * The second guard is additionally CLI-only. `output === undefined` is what
 * "this is the CLI" means here — the same seam the renderer is selected by — and
 * a programmatic caller that supplies its own sink drives init deliberately.
 *
 * Returns false when init must stop with exit 1. */
async function guardUnattendedRun(input: {
  root: string;
  options: InitOptions;
  output: Output;
  interactive: boolean;
}): Promise<boolean> {
  if (input.options.agent === true) return true;
  if (!await guardUndetectedFramework(input)) return false;
  return input.options.output !== undefined || await guardNonInteractive(input);
}

/** The env every credential consumer reads. Dev keys may live in .env.local
    rather than this process's env — a PRIOR run's minted starter key, or
    hand-added provider keys — so they are merged in for the credential ladder,
    the cloud step, the theme model pass and the AI polish. An explicit env
    value always wins over .env.local. */
function credentialEnv(root: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  let effective = env;
  for (const name of [...ENV_KEY_VARS.map((entry) => entry.envVar), "VENDO_API_KEY"]) {
    if ((env[name] ?? "").trim() !== "") continue;
    const stored = envFileValueSync(root, name);
    if (stored !== null) effective = { ...effective, [name]: stored };
  }
  return effective;
}

/** Is a provider key in this host's environment? The models QUESTION reads this
    to know whether it still has to be asked; the wiring below does not. */
function providerKey(root: string, options: InitOptions): ScaffoldModel | null {
  const env = credentialEnv(root, options.env ?? process.env);
  const found = ENV_KEY_VARS.find((entry) => (env[entry.envVar] ?? "").trim() !== "");
  return found === undefined ? null : { provider: found.provider, envVar: found.envVar };
}

/**
 * What the composition's `models` line should say — decided by the models
 * ANSWER, never by what happens to be in the environment.
 *
 * Vendo Cloud (a usable key in hand) → null. The runtime ladder resolves the
 * model from `VENDO_API_KEY` on its own (harnesses/src/inference/resolve.ts),
 * so writing `anthropic("claude-sonnet-4-6")` here would override the answer the
 * user just gave with whatever key was lying around in their shell — and the
 * comment beside it would name a key the wiring does not read.
 *
 * Own key → the provider key it found, written as the explicit selection. Since
 * the selection law an ambient key selects nothing by itself, so that line is
 * exactly what this host needs.
 *
 * Called AFTER the cloud step, which is when the answer exists at all — and by
 * then a key pasted during it is already in .env.local, which `credentialEnv`
 * reads.
 */
function wiredModel(root: string, options: InitOptions, cloudKeyValid: boolean): ScaffoldModel | null {
  return cloudKeyValid ? null : providerKey(root, options);
}

/** Key first (product order fix): the model-credential story — env keys,
 *  else the Vendo Cloud offer — runs BEFORE the AI-assisted passes, so a
 *  starter key minted here powers the SAME run's theme model pass and AI
 *  polish instead of those passes reporting "no model" while the offer
 *  waits below them. --yes / non-interactive semantics are unchanged. */
async function resolveModelCredential(input: {
  root: string;
  env: Record<string, string | undefined>;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
}): Promise<{ credential: DevCredential; cloud: Awaited<ReturnType<typeof runCloudStep>> }> {
  const { root, env, options, output, pretty } = input;
  let effectiveEnv = credentialEnv(root, env);
  let credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
  if (credential.rung === "env-key") {
    // Their key is a decision already made, so this stays a statement and
    // never a prompt — but it now names the door. A BYO user used to finish
    // init without learning Vendo Cloud exists at all, because the offer
    // vanishes entirely on this branch. The renderer's CTA rule picks the
    // command out; the copy is written once, here.
    output.log(
      `Model: ${describeDevCredential(credential)} — Vendo Cloud adds hosted automations + the console; `
      + "run `vendo login` anytime.",
    );
  }
  const cloud = await runCloudStep({
    root,
    output,
    // --byo answers the offer with "no" AND suppresses the agent-path
    // auth.md pointer (an explicit BYO choice is final); --yes skips the
    // prompt but still gets the pointer so an agent can mint in-band.
    yes: options.yes === true,
    byo: options.byo === true,
    credential,
    // The RUN's env, not process.env: a programmatic caller's key must be
    // what the probe and the mint see (seams in options.cloud still win).
    env: effectiveEnv,
    // The step's own command_run row rides init's telemetry seams.
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    // The models select and the bring-your-own paste belong to every human
    // terminal, not just a colourful one: NO_COLOR is a normal thing for a
    // developer to set, and a question that only exists in pretty mode is a
    // feature that disappears for them. The plain pair carries plainSelect's
    // non-TTY guard, and cloud-init only reaches for either on a real TTY.
    select: pretty === null ? plainSelect : pretty.select,
    askSecret: pretty === null ? plainSecret : pretty.secret,
    // The SAME gate that selected the renderer above: a rail is on screen, so
    // the ceremony's machine-readable receipt would be noise under it.
    ...(pretty === null ? {} : { confirm: pretty.confirm, pretty: true }),
    // --byo is an ANSWER to the models question, so it rides `models`.
    // --cloud-key is not: it lands the key in .env.local before this step
    // runs, so the probe finds it and the question never gets asked. Passing
    // "cloud" here instead would send a run that ALREADY HAS a key into the
    // mint ceremony — a live device login for a key the user just supplied.
    ...(options.byo === true ? { models: "byo" as const } : {}),
    ...(options.cloud ?? {}),
  });
  // Same-run pickup: a starter key minted just now lands in .env.local —
  // merge it the same way so THIS run's passes already benefit.
  if (cloud.wroteEnvLocal) {
    const minted = envFileValueSync(root, "VENDO_API_KEY");
    if (minted !== null) {
      effectiveEnv = { ...effectiveEnv, VENDO_API_KEY: minted };
      credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
    }
  }
  // A provider key the user just pasted counts the same way: this run's
  // model passes benefit from it, not the next one.
  if (cloud.wroteKeyVar !== undefined) {
    const pasted = envFileValueSync(root, cloud.wroteKeyVar);
    if (pasted !== null) {
      effectiveEnv = { ...effectiveEnv, [cloud.wroteKeyVar]: pasted };
      credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
    }
  }
  return { credential, cloud };
}

/** Wire — apply the bounded change set. No gates, no prompts. Then scan:
 *  the .vendo artifacts + static extraction (the hints layer for the AI
 *  extraction; interim tools.json source until it lands).
 *
 *  Returns the elapsed wiringMs the cloud telemetry lane reports. */
async function wireAndScaffold(input: {
  root: string;
  changes: PlannedChange[];
  force: boolean;
  useCase: InitUseCase;
  /** The env var the composition's `models` wiring reads (see `wiredModel`). */
  modelKey: string | null;
}): Promise<number> {
  const { root, changes, force, useCase, modelKey } = input;
  const wiringStarted = Date.now();
  for (const change of changes) {
    await writeText(change.absolute, change.after);
  }

  await ensureVendoEnvExample(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  // Not writeIfMissing: these are THE answers this run resolved, and doctor
  // reads them to know which checks a mounted-UI-less install can never pass and
  // which model key this host's own wiring consults.
  await writeInstallRecord(root, { useCase, modelKey });
  await writeIfMissing(
    join(root, ".vendo", "overrides.json"),
    `${JSON.stringify({
      format: "vendo/overrides@3",
      tools: {},
      remix: { ignoreSlots: [] },
    }, null, 2)}\n`,
    force,
  );
  await writeIfMissing(
    join(root, ".vendo", "policy.json"),
    `${JSON.stringify({
      format: "vendo/policy@1",
      directions: [],
      rules: [
        { match: { risk: "destructive" }, action: "ask", note: "Review irreversible actions" },
        // ENG-370 hardening: knowledge tools are read-class, so this rule
        // must sit ABOVE the read→run rule (first match wins). MCP clients
        // sit outside the product surface; hosts may harden ask → block.
        { match: { tool: "vendo_knowledge_*", venue: "mcp" }, action: "ask", note: "Knowledge access from an MCP client" },
        { match: { risk: "read" }, action: "run" },
      ],
    }, null, 2)}\n`,
    force,
  );
  await writeIfMissing(
    join(root, ".vendo", "brief.md"),
    BRIEF_PLACEHOLDER,
    force,
  );
  await writeIfMissing(join(root, ".vendo", "data", ".gitignore"), "*\n!.gitignore\n", force);
  return Date.now() - wiringStarted;
}

/** init ENDS in the one shared flow — the same extraction, theme path,
 *  consent, judgment, prose stages, report and Cloud pushes `vendo sync`
 *  runs, in "full" mode (a fresh install has judged nothing). */
async function runInstallSyncFlow(input: {
  root: string;
  output: Output;
  options: InitOptions;
  pretty: PrettyOutput | null;
  /** The judgment answer init settled during its question phase (null when
      there was nothing to ask). Passing it is what keeps the flow silent. */
  consent: { ai: boolean; engine?: string } | null;
}): Promise<SyncFlowResult> {
  const { root, output, options, pretty, consent } = input;
  // `--extract` is the test seam onto the flow's judgment step, in init's own
  // flat spelling; where it overlaps a real flag, the seam wins.
  const extract = options.extract ?? {};
  const ai = extract.ai ?? options.ai ?? consent?.ai;
  const engine = extract.engine ?? options.engine ?? consent?.engine;
  return runSyncFlow({
    root,
    output,
    mode: "full",
    // The AI-polish step keeps its OWN interactivity posture (a real TTY that
    // no package script drives), distinct from `interactive` above — that one
    // is the auth confirm's seam, and spending money on a model is not a
    // question a programmatic caller may be assumed to have answered.
    interactive: extract.interactive
      ?? (!invokedByPackageScript() && Boolean(stdin.isTTY) && Boolean(stdout.isTTY)),
    yes: options.yes === true,
    // Agent mode ALWAYS grades. The caller being a model is not a substitute:
    // the pass is a scripted engine run with a verbatim quote behind every
    // proposal and an independent skeptic over each one, so "delegated to you"
    // meant every agent install shipped an ungraded catalog whose every tool
    // asked on each call. The mode IS the consent; only an explicit `--no-ai`
    // still refuses, and a machine with no engine at all falls through to the
    // receipt's checklist (runInit's judgment line says so out loud).
    ...(options.agent === true && ai === undefined ? { ai: true } : {}),
    // --ai IS the consent (no prompt, non-interactive runs stop skipping);
    // --no-ai is the refusal. With no flag, `consent` above carries the answer
    // init already collected up front, so the flow never asks either way.
    ...(ai === undefined ? {} : { ai }),
    // A loosening is never applied without a human, and init stopped asking
    // once its questions were done — so they queue as pending and the closing
    // facts report the count.
    queueLoosenings: true,
    ...(options.force === true ? { force: true } : {}),
    ...(engine === undefined ? {} : { engine }),
    // The questions AND the spinner, in the one spelling sync uses: passing
    // only the questions is what left every slow phase of an install frozen
    // (#1163).
    ...rendererFlowOptions(pretty),
    ...(extract.choose === undefined ? {} : { choose: extract.choose }),
    judge: {
      ...(extract.harnesses === undefined ? {} : { harnesses: extract.harnesses }),
      ...(extract.confirm === undefined ? {} : { confirm: extract.confirm }),
      ...(extract.resolveCredential === undefined ? {} : { resolveCredential: extract.resolveCredential }),
    },
  });
}

/** The three dependency repairs a fresh install owes the host, each degrading
 *  to a printed command rather than failing the run. */
async function ensureHostDeps(input: {
  root: string;
  output: Output;
  options: InitOptions;
  credential: DevCredential;
  /** The provider whose import this run wrote into the composition, if any. */
  wrote: ScaffoldModel["provider"] | undefined;
  /** The source of every code file this run CREATED — what its imports demand
      of the host's package.json (see ensureGeneratedImports). */
  generated: readonly string[];
}): Promise<void> {
  const { root, output, options, credential, wrote, generated } = input;
  // Every package those generated files import has to be a declared dependency
  // of the host, or the app cannot compile what init just wrote. First, so the
  // declaration is in place before the resolvability repair below asks about it.
  await ensureGeneratedImports({
    root,
    sources: generated,
    output,
    ...(options.installVendo === undefined ? {} : { run: options.installVendo }),
  });

  // #1153: the scaffolds this run wrote import `@vendoai/vendo/*`, and a host
  // installed under the `vendoai` alias alone cannot resolve them under pnpm's
  // strict node_modules — the route fails to COMPILE and every request 500s.
  await ensureVendoPackage({
    root,
    output,
    ...(options.installVendo === undefined ? {} : { run: options.installVendo }),
  });

  // The provider must be resolvable from the host or the FIRST turn 500s
  // (dev-creds/model.ts loads it host-side; nothing declares @ai-sdk/* — 0.4.1
  // E2E cert finding). Two sources, because since the selection law they differ:
  // the resolved CREDENTIAL names what a runtime turn loads, and `wrote` names
  // the import this run just authored — a bare provider key is `rung: "none"`,
  // so the credential alone said "nothing to install" for a route that had just
  // been given an `@ai-sdk/*` import, and the host's build could not resolve it.
  // A failure degrades to the manual command.
  await ensureProviderDeps({
    root,
    credential,
    ...(wrote === undefined ? {} : { wrote }),
    output,
    ...(options.installProvider === undefined ? {} : { run: options.installProvider }),
  });

  // FINDINGS F2 (skateshop): a host pinning zod < 3.25 builds red once the
  // wiring pulls ai@6 into the bundle (ai imports the zod/v3 + zod/v4
  // subpaths that arrive in 3.25, and the host's own pin wins the installed
  // tree). It does not ASK — this runs minutes past the question phase, where
  // the person who started the install has walked away — so `--yes` performs
  // the announced bump and every other run states the problem and the command
  // (doctor grades the gap as E-DEP-003).
  await ensureZodFloor({
    root,
    output,
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.installZod === undefined ? {} : { run: options.installZod }),
  });
}

/** The LAST of the up-front questions: may a coding agent read this codebase,
 *  and where several could, which one. It used to be asked INSIDE the flow, at
 *  the top of the pass that then runs for minutes — well past the point the
 *  person who started the install had walked away. It is knowable before any of
 *  that (the engine ladder is a read-only probe of this machine), so init asks
 *  it here and hands the flow a settled answer.
 *
 *  Null means there is nothing to ask, and the flow keeps its own silent
 *  handling: `--ai`/`--no-ai` and agent mode already answered, `--yes` takes the
 *  defaults, a run that cannot ask cannot ask, and a machine with no engine at
 *  all has no question to put.
 *
 *  The posture is the JUDGMENT step's own — a real TTY that no package script
 *  drives — and deliberately not init's run-wide `interactive`: spending money
 *  on a model is not a question a programmatic caller may be assumed to have
 *  answered, and this is also the gate that keeps the engine ladder (a
 *  subprocess probe of this machine) off every run that would never ask. */
async function askJudgmentUpFront(input: {
  root: string;
  env: Record<string, string | undefined>;
  options: InitOptions;
  pretty: PrettyOutput | null;
}): Promise<{ ai: boolean; engine?: string } | null> {
  const { root, options, pretty } = input;
  const seam = options.extract ?? {};
  const attended = seam.interactive
    ?? (!invokedByPackageScript() && Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  if (!attended || options.agent === true || options.yes === true) return null;
  if ((seam.ai ?? options.ai) !== undefined) return null;
  return await resolveJudgmentConsent({
    root,
    env: await readEnvFiles(root, input.env),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(seam.harnesses === undefined ? {} : { harnesses: seam.harnesses }),
    // Renderer first, seams last: a stubbed prompt always wins.
    ...(pretty === null ? {} : { choose: pretty.select, confirm: pretty.confirm }),
    ...(seam.choose === undefined ? {} : { choose: seam.choose }),
    ...(seam.confirm === undefined ? {} : { confirm: seam.confirm }),
  });
}

/** The key the install RECORDS as the one its wiring reads — only ever what
 *  THIS run wired. A composition init did not author is the authority on
 *  itself, and doctor reads that file's own `models` line, so a run that wired
 *  nothing new keeps whatever answer an earlier one established. */
async function recordedModelKey(input: {
  root: string;
  models: ScaffoldModel | null;
  landed: ScaffoldPlan["modelWritten"];
  cloudKeyValid: boolean;
  authoredComposition: boolean;
}): Promise<string | null> {
  if (input.landed !== null && input.models !== null) return input.models.envVar;
  if (input.cloudKeyValid && input.authoredComposition) return "VENDO_API_KEY";
  return await readModelKey(input.root) ?? null;
}

/** The run's LAST words, in both modes: what it wired, what it detected, the
 *  guard posture it left, and the ONE page that carries the instructions —
 *  as prose, or as the `--agent` receipt over the same object. No run prints
 *  both, and neither shape carries a step, a snippet or a command. */
async function emitEnding(input: {
  root: string;
  options: InitOptions;
  output: Output;
  useCase: InitUseCase;
  framework: Exclude<HostFramework, "unknown"> | "custom";
  wrote: string[];
  keptUncertain: string[];
  pendingLoosenings: number;
  serviceAuthUnwired: boolean;
  judged: boolean;
}): Promise<void> {
  const { root, options, output, useCase, framework, wrote, keptUncertain, pendingLoosenings } = input;
  const auth = await detectAuthPreset(root);
  const facts: InitFacts = {
    wrote,
    detected: {
      framework: FRAMEWORK_NAMES[framework],
      auth: auth.matches.length === 0
        ? "no auth detected"
        : auth.matches.map((match) => AUTH_FAMILY_INFO[match.preset].name).join(" / "),
      packageManager: await detectPackageManager(root),
      port: await devPort(root),
    },
    guardPosture: GUARD_POSTURE,
    continueUrl: await continueUrl(root, useCase),
    keptUncertain,
    pendingLoosenings,
  };
  if (options.agent === true) {
    output.log(JSON.stringify({
      status: "written",
      root,
      useCase,
      ...facts,
      ...(input.serviceAuthUnwired ? { serviceAuthUnwired: true } : {}),
      judgment: input.judged
        ? { status: "graded", file: join(".vendo", "judgments.json") }
        : { status: "delegated", checklist: JUDGMENT_CHECKLIST },
    } satisfies InitReceipt, null, 2));
    return;
  }
  const { framework: name, auth: family, packageManager, port } = facts.detected;
  output.log(`\nWired: ${facts.wrote.join(", ")}`);
  output.log(`Detected: ${name} · ${family} · ${packageManager} · port ${port}`);
  output.log(`Guard: ${facts.guardPosture}`);
  if (facts.keptUncertain.length > 0) {
    output.log(`Kept as extracted (uncertain): ${facts.keptUncertain.join(", ")}`);
  }
  if (facts.pendingLoosenings > 0) {
    output.log(`Pending review: ${facts.pendingLoosenings} loosening proposal${facts.pendingLoosenings === 1 ? "" : "s"} held, none applied — \`vendo sync --review\``);
  }
  output.log(`Continue: ${facts.continueUrl}`);
}

/** #478 + FINDINGS F3 — the end-of-run summary warns on an `ai` outside the
 *  peer contract instead of waiting for doctor's E-DEP-001. The contract admits
 *  both live majors (6 and 7), so only the two edges warn: npm installs a peer
 *  conflict without failing, and the re-read only sees a pre-v6 copy when
 *  ensureProviderDeps could not install over the hoisted one. */
async function warnOffContractAi(root: string, output: Output): Promise<void> {
  const aiVersion = await installedAiVersion(root);
  if (aiVersion !== null && Number.parseInt(aiVersion, 10) >= 8) {
    output.error(`warning: installed ai@${aiVersion} is a major Vendo has never been run against — Vendo speaks ai@6 and ai@7; pin one (npm install ai@^7 @ai-sdk/anthropic@^4 @ai-sdk/react@^4) or track github.com/runvendo/vendo/issues/478`);
  } else if (aiVersion !== null && aiBelowPeerFloor(aiVersion)) {
    output.error(`warning: installed ai@${aiVersion} predates the ai@6 peer contract — every turn fails at runtime until the app resolves its own ai@6 (E-DEP-001).`);
  }
}

export async function runInit(input: InitOptions): Promise<number> {
  // Agent mode answers every MECHANICAL question the way `--yes` does — the
  // base URL, the zod floor, the theme slots — so they land in the diff instead
  // of in someone's chat. Only what a person must decide is relayed, and that
  // happens before anything here writes.
  const options: InitOptions = input.agent === true ? { ...input, yes: true } : input;
  // The clack-style renderer rides the SAME Output seam: it restyles the
  // exact plain messages below, and is selected only for a human terminal
  // (TTY, no NO_COLOR/CI, never --agent, never an injected output). Every
  // other run — tests, pipes, CI — keeps the plain strings byte-for-byte.
  const pretty: PrettyOutput | null =
    options.output === undefined && options.agent !== true && usePrettyOutput()
      ? createPrettyOutput()
      : null;
  const output = options.output ?? pretty ?? consoleOutput;
  const started = Date.now();
  const root = resolve(options.targetDir);
  const env = options.env ?? process.env;

  /** A plan failure the HOST must fix (a manifest npm itself would refuse)
      exits with the CLI's normal one-line error instead of a raw stack. */
  const explainedPlanFailure = (error: unknown): boolean => {
    if (isVendoError(error) && error.code === "validation") {
      output.error(`vendo init: ${error.message}`);
      return true;
    }
    return false;
  };

  // The one explained-failure funnel for both plan calls (--agent and the
  // scaffolding run): a validation-shaped failure prints its one clean
  // sentence and the caller exits 1; anything else propagates untouched.
  const buildPlanOrExplained = async (
    ...args: Parameters<typeof buildPlan>
  ): Promise<Awaited<ReturnType<typeof buildPlan>> | null> => {
    try {
      return await buildPlan(...args);
    } catch (error) {
      if (explainedPlanFailure(error)) return null;
      throw error;
    }
  };

  // Detect + confirm (interactive runs only): --yes and non-interactive runs
  // accept the detected default silently — the same interactivity posture as
  // the AI-polish consent. Agent mode is never interactive: its questions
  // travel as JSON, so nothing on that run may prompt.
  const interactive = options.agent !== true
    && (options.interactive
      ?? (!invokedByPackageScript() && Boolean(stdin.isTTY) && Boolean(stdout.isTTY)));
  if (!await guardUnattendedRun({ root, options, output, interactive })) return 1;

  // Ask first (agent mode): detection has run, so whatever a PERSON still owes
  // an answer to leaves as ONE JSON object and this run writes nothing. The
  // answers come back as flags and the re-run writes; a call that already
  // carries them all falls through and writes in this one pass.
  if (options.agent === true) {
    const cloudKey = (credentialEnv(root, env)["VENDO_API_KEY"] ?? "").trim() !== "";
    const questions = await initQuestions({
      root,
      options,
      framework: await resolveFramework(root, options),
      modelKey: cloudKey || providerKey(root, options) !== null,
      cloudKey,
      devPort: await devPort(root),
      // Only when the use case is still open — the scan costs a source walk, and
      // an answered question has nothing left to recommend.
      ...(options.useCase === undefined ? { agentLoopRoute: await detectAgentLoopRoute(root) } : {}),
    });
    if (questions !== null) {
      output.log(JSON.stringify(questions, null, 2));
      return 0;
    }
  }

  await printStack({ root, options, output, pretty });
  const useCase = await resolveUseCase({ root, options, pretty, interactive });

  // (No stdin-TTY guard on these defaults: an unshown auth confirm resolving
  // its default just wires the detected preset — the very accept the
  // non-interactive path performs silently anyway.)
  const confirmAuth = options.yes === true || !interactive
    ? undefined
    : (options.confirmAuth ?? (pretty === null ? askYesNo : pretty.confirm));
  const selectAuth = options.yes === true || !interactive
    ? undefined
    : (options.selectAuth ?? (pretty === null ? plainSelect : pretty.select));
  const detectStarted = Date.now();
  const built = await buildPlanOrExplained(options, confirmAuth, selectAuth);
  if (built === null) return 1;
  const { plan, changes, authAdvice, authWired, compositionPath, rewriteModels } = built;
  const detectMs = Date.now() - detectStarted;
  let telemetry = telemetryFor(options, output, root);
  await telemetry.track("init_started", { framework: plan.framework });

  try {
    // --cloud-key: the flag answer to the cloud-login offer — the supplied
    // key lands exactly where the mint would (.env.local), so the merge
    // below picks it up and the offer never fires.
    if (options.cloudKey !== undefined) {
      await upsertEnvLocal(root, "VENDO_API_KEY", options.cloudKey);
      output.log("Wrote VENDO_API_KEY to .env.local (--cloud-key).");
      await ensureEnvLocalIgnored(root, output);
    }
    const { credential, cloud } = await resolveModelCredential({ root, env, options, output, pretty });
    // A key that landed in .env.local THIS run (--cloud-key upsert or the
    // login ceremony) must activate the telemetry cloud lane for the rest of
    // this run's events too — rebuild the client so it re-reads .env.local.
    // A pre-existing key was already picked up at the first construction.
    if (options.cloudKey !== undefined || cloud.wroteEnvLocal) {
      telemetry = telemetryFor(options, output, root);
    }

    // "Where does this app run in dev?" — asked HERE on every path, with the
    // rest of the questions. The MCP arm reads the answer back (a broker door
    // refuses a non-https origin). It used to be asked at the very end, minutes past
    // the AI pass, by which point the person who started the install had walked
    // away; the MCP arm always needed it up here anyway, since the door derives
    // every discovery URL from it. The MCP arm's own two questions follow, and
    // then nothing in this run prompts again.
    const baseUrl = await captureDevBaseUrl({ root, options, output, pretty });

    const consent = await askJudgmentUpFront({ root, env, options, pretty });

    // The models ANSWER, now that the cloud step has settled it: a usable Cloud
    // key resolves the model at runtime and writes no line; otherwise the
    // provider key found here is written as the explicit selection. Both the
    // composition and the install record read this one value.
    const models = wiredModel(root, options, cloud.keyValid);

    let mcp: Awaited<ReturnType<typeof planMcpScaffold>> = null;
    if (useCase === "mcp") {
      mcp = await planMcpScaffold({
        root, options, output, pretty, interactive, changes, models, baseUrl,
        framework: plan.framework, authWired, cloudKey: cloud.keyValid,
      });
    }
    // The MCP arm re-renders the same composition, so it owns the line where it
    // has one; everywhere else the plan's own renderer writes it. The change
    // objects are still unwritten at this point.
    const modelLanded = useCase === "mcp"
      ? mcp?.modelWritten ?? null
      : models === null ? null : rewriteModels?.(models) ?? null;

    const modelKey = await recordedModelKey({
      root, models, landed: modelLanded,
      cloudKeyValid: cloud.keyValid,
      authoredComposition: compositionPath !== null,
    });

    pretty?.spin("Wiring your app…");
    const wiringMs = await wireAndScaffold({ root, changes, force: options.force === true, useCase, modelKey });
    pretty?.stopSpin();

    // Summary — what changed. What was LEARNED is the shared flow's report,
    // printed by the flow itself a few lines down.
    if (changes.length > 0) {
      output.log(`\nWired (${changes.length} file${changes.length === 1 ? "" : "s"}):`);
      for (const change of changes) {
        output.log(`  ${change.before === null ? "+" : "~"} ${change.path}`);
      }
    } else {
      output.log("\nAlready wired — nothing to change.");
    }
    // Detection-as-advice (zero-question contract): a wired preset stays
    // silent — the comment in the scaffold cites the escape hatch; none or
    // ambiguous gets exactly one calm line naming the line to add.
    if (authAdvice !== null) output.log(authAdvice);

    // init ENDS in the one shared flow — the same extraction, theme path,
    // consent, judgment, prose stages, report and Cloud pushes `vendo sync`
    // runs, in "full" mode (a fresh install has judged nothing). Install-only
    // work stays above this line; everything below it is the flow's, and init
    // stays fail-LOUD: the catch at the bottom still exits 1.
    const themePath = join(root, ".vendo", "theme.json");
    const engineStarted = Date.now();
    const flow = await runInstallSyncFlow({ root, output, options, pretty, consent });
    const engineMs = Date.now() - engineStarted;
    const { themeSummary, counts: { tools: toolCount, routes: routeCount } } = flow;

    // Theme finalization (Task 4): merge whatever the AI pass filled — if
    // consent was declined or unavailable, `flow.themeDraft` is simply null
    // and the exact-only summary stands — then --theme answers (a human
    // "(you)" wins over a model value) and the one-glance palette print.
    // Skipped entirely when theme.json pre-existed this run (the flow
    // reconciles that one instead).
    const keptUncertain = themeSummary === null
      ? []
      : await finalizeTheme({ root, themeSummary, themeDraft: flow.themeDraft, themePath, options, output });

    // Judgment state, one line: a pass that ran already narrated itself (it
    // owns the judged/queued/rejected counts); otherwise say so honestly.
    if (!flow.judged.ran) output.log(ungradedLine(options.agent === true));

    // Project-shape enrichment (posthog-analytics §3): bools, closed enums,
    // counts, and bare dependency versions only — never names or content.
    await telemetry.track("init_completed", {
      framework: plan.framework,
      command: "init",
      toolCount,
      durationMs: Date.now() - started,
      typescript: await exists(join(root, "tsconfig.json")),
      router: await detectRouter(root, plan.framework),
      // The engine that actually ran the AI polish; "none" when it didn't run.
      engine: flow.judged.engine ?? "none",
      // route-scan today; "zod" is reserved for a future oracle-backed detect
      // (the zod collector currently enriches route-scan output invisibly).
      apiDetectMethod: routeCount > 0 ? "route-scan" : "none",
      routeCount,
      themeExtracted: themeSummary !== null,
      ...(await detectDepVersions(root, plan.framework)),
      // Cloud-lane-only props, passed unconditionally — the client strips
      // every one of them in the anonymous lane.
      detectMs,
      engineMs,
      ...(flow.themeMs === undefined ? {} : { themeMs: flow.themeMs }),
      wiringMs,
      ...(await cloudProjectProps(root)),
    });

    await ensureHostDeps({
      root, output, options, credential,
      wrote: modelLanded?.provider,
      generated: generatedSources(changes),
    });

    // The one line that closes the model story. A provider key is a credential
    // now, not a selection: nothing picks a model off the environment any more,
    // so the run says which model it SELECTED for them and in which file — the
    // explicit config is already there to edit, and no first boot fails on the
    // removed ambient behaviour.
    if (modelLanded !== null) {
      output.log(`models: ${modelLanded.provider} — written into ${modelLanded.path}`);
    }
    // The one short Cloud reminder in the end-of-run summary — ONLY while this
    // host has no model at all (the full emphasized block already ran up top; no
    // repeat). A provider key resolves to `rung: "none"` since the selection law,
    // so the models line above is the other half of the test: without it this
    // line contradicted the line directly above it. And it names what the key
    // alone no longer does — advising the bare variable was the whole bug.
    if (credential.rung === "none" && modelLanded === null) {
      output.log("No model key yet: select one in your composition — models: { default: anthropic(\"claude-sonnet-4-6\") } — with ANTHROPIC_API_KEY in .env.local, or run `vendo login` for a free dev key (VENDO_API_KEY). A provider key alone no longer selects a model.");
    }

    await warnOffContractAi(root, output);

    // `wrote` names files the caller may open, so the plan's static list is
    // filtered to what is actually on disk: fonts.css exists only when a font
    // was embedded, and naming it would send a reader to a file that is not
    // there.
    const planned = (await Promise.all(
      plan.writes.map(async (path) => await exists(join(root, path)) ? path : null),
    )).filter((path): path is string => path !== null);

    await emitEnding({
      root, options, output, useCase, framework: plan.framework, keptUncertain,
      wrote: [...planned, ...changes.map((change) => change.path)],
      pendingLoosenings: flow.judged.queued,
      serviceAuthUnwired: mcp?.serviceAuthUnwired === true,
      judged: flow.judged.ran,
    });

    // Called on its OWN line, never inside `pretty?.done(…)`: optional
    // chaining short-circuits its arguments, so a null `pretty` — every
    // non-TTY run — would skip the entire ending without a trace.
    pretty?.done(Date.now() - started, true, runStats({ toolCount, brandCaptured: themeSummary !== null }));
    return 0;
  } catch (error) {
    await telemetry.track("init_failed", {
      framework: plan.framework,
      failedStep: "wiring",
      errorClass: errorClass(error),
      // Cloud lane only (stripped anonymously); scrubbed at the call site and
      // re-scrubbed by the client as defense-in-depth.
      errorDetail: scrubErrorDetail(error instanceof Error ? error.message : String(error)),
    });
    await telemetry.track("error_class", { errorClass: errorClass(error) });
    output.error(error instanceof Error ? error.message : "vendo init failed");
    pretty?.done(Date.now() - started, false);
    return 1;
  }
}
