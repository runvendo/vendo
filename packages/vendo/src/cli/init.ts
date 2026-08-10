import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtractedTool, OverridesFile } from "@vendoai/actions";
import { mergeOverrides, vendoSync } from "@vendoai/actions/sync";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { scrubErrorDetail, type Telemetry } from "@vendoai/telemetry";
import { detectDepVersions, installedAiVersion } from "./dep-versions.js";
import { AUTH_MD_URL, ensureEnvLocalIgnored, runCloudStep, upsertEnvLocal, type CloudStepOptions } from "./cloud-init.js";
import { runDoctor } from "./doctor.js";
import type { InitPolishSeam } from "./init-judgment.js";
import { planMcp, type McpPosture } from "./init-mcp.js";
import { rendererFlowOptions, runSyncFlow, type SyncFlowResult } from "./sync-flow.js";
import { BRIEF_TEMPLATE } from "./extract/stages.js";
import { ENV_KEY_VARS, resolveDevCredential, describeDevCredential, type DevCredential } from "../dev-creds/resolve.js";
import { detectFramework, detectVendoWiring, workspaceHostCandidates, type HostFramework } from "./framework.js";
import {
  AUTH_FAMILY_INFO,
  detectAuthPreset,
  resolveScaffoldAuth,
  type AuthMatch,
  type AuthPresetName,
  type ConfirmAuth,
  type SelectAuth,
} from "./init-auth.js";
import { ensureProviderDeps, ensureVendoPackage, ensureZodFloor, type InstallRunner } from "./provider-deps.js";
import {
  customServerSource,
  expressServerSource,
  importsGeneratedMap,
  missingRegistrationLines,
  missingRegistrations,
  requiredServerActions,
  routeSource,
  serverActionsModuleSource,
  serverActionsWiring,
  VENDO_ENV_EXAMPLE,
} from "./init-scaffolds.js";
import { createPrettyOutput, plainSecret, plainSelect, plainText, usePrettyOutput, type PrettyOutput, type SelectOption } from "./pretty.js";
import { contrastingText } from "./theme/color.js";
import {
  applyThemeDraft,
  toVendoTheme,
  validateSlotValue,
  type ThemeSlotValues,
  type ThemeSummary,
} from "./theme/extract-theme.js";
import {
  appDirectory,
  askYesNo,
  clientRoot,
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
 * `vendo init` (install-dx v1, re-derived 2026-07-18): one command, zero
 * questions on the happy path, no ceremony.
 *
 *   scan → wire (the server surface — the catch-all handler holding the
 *   composition; init never writes a client file;
 *   a detected auth preset gets one consent-style confirm in interactive runs,
 *   --yes/non-interactive accept it silently — plus package.json hooks)
 *   → key (env stated, else the cloud starter offer) → done summary (files
 *   changed, the mount paste, next steps).
 *
 * INIT ONLY EVER CREATES FILES IN YOUR SOURCE TREE (locked DX law). Everything
 * above is a NEW Vendo-owned file, or Vendo-owned config: `package.json`'s two
 * sync hooks, and one idempotent append of `VENDO_BASE_URL` to `.env.example`
 * (the only pre-existing host-authored file init still writes, and it appends
 * — it never rewrites a line). A source file that already exists is never
 * written at all, however stale: mounting the visible
 * surface in the host's own layout, wiring `serverActions` into a route that
 * predates the host's actions, refreshing a stale registration map — each one
 * is the developer's paste, so the run ends with one unmissable block naming
 * the file and the exact lines (the `ManualEdit`s below), and `vendo doctor`
 * fails until they land (E-WIRE-004, E-WIRE-009).
 *
 * Removed by design: the interview, per-diff y/N approvals, the lib/ai.ts
 * scaffold (createVendo's `model` is optional now), remix offers, the
 * encryption-key step, the refine offer (the `vendo refine` command itself is
 * gone — format v3 replaces it with the enrichment pass), and the finale
 * ceremony (doctor owns verification and the live turn).
 */

const BRIEF_PLACEHOLDER = `${BRIEF_TEMPLATE}\n`;

export interface RiskRecommendation {
  tool: string;
  risk: ExtractedTool["risk"];
  recommendation: string;
}

/** A step init cannot take for you. Init only ever CREATES files in your source
    tree, so every change to a file that already exists — the visible-surface
    mount, the server-action wiring — is the developer's paste, structured so
    the terminal block, the `manualSteps` lines, and the `--agent` plan all
    carry the SAME file and lines. */
export interface ManualEdit {
  /** The file the paste goes in, relative to the init root. */
  file: string;
  /** The exact lines to paste (or the diff to apply), in order. */
  lines: string[];
  /** What skipping it costs. */
  why: string;
}

/** How the host's people will reach the agent — the run's FIRST question. It
    decides what gets scaffolded and how the run ends; the wired route is the
    same in all three, so picking wrong costs nothing. */
export type InitUseCase = "embedded" | "agent-loop" | "mcp";

export const INIT_USE_CASES: readonly InitUseCase[] = ["embedded", "agent-loop", "mcp"];

export interface InitPlan {
  framework: Exclude<HostFramework, "unknown"> | "custom";
  /** --use-case only: absent on a run that never named one, so an unattended
      plan stays byte-identical to the one agents parse today. */
  useCase?: InitUseCase;
  root: string;
  writes: string[];
  codeChanges: Array<{ path: string; diff: string }>;
  /** Whatever wiring the run could not do safely itself: the paste lines for
      the user. Always carries the mount when one is outstanding. */
  manualSteps: string[];
  /** The mount paste as data (absent when a surface is already mounted, and
      on Express/custom hosts, whose two wiring lines have no single file to
      name — they ride `manualSteps`). */
  mount?: ManualEdit;
  /** Changes init found for files that already exist and it therefore will not
      write: an existing route.ts missing its `serverActions` wiring, a
      registration map that has fallen behind the host's `"use server"`
      surface. Absent when there are none. */
  edits?: ManualEdit[];
  /** --agent only: deterministic extraction results, so an agent can act on
      real tool names instead of re-deriving them. */
  extraction?: { tools: ExtractedTool[]; warnings: string[] };
  riskRecommendations?: RiskRecommendation[];
}

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
  /** --base-url: answer "where will this deploy?" without asking. Written to
      .env.example ONLY, by replacing init's own localhost placeholder — never
      .env.local, where a production URL would repoint local dev's discovery,
      callbacks and credential forwarding at the deployed origin. */
  baseUrl?: string;
  /** --posture: how outside agents sign in (MCP use case only). */
  posture?: McpPosture;
  /** --service-key: set up a machine-to-machine key (MCP use case only). */
  serviceKey?: boolean;
  /** --check / --no-check: run `vendo doctor` at the end. Only OFFERED when
      the run owes no paste — doctor grades the paste, and the paste happens
      after init exits. Never changes init's exit code either way. */
  check?: boolean;
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
  /** Test seam: the zod-floor bump confirm (provider-deps.ts, FINDINGS F2),
      asked only in interactive runs. Mirrors the auth confirm's shape. */
  confirmZodBump?: (question: string, defaultYes: boolean) => Promise<boolean>;
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
  /** Test seam: the free-text asks (the base URL). "" is a decline. */
  askText?: (question: string, hint?: string) => Promise<string>;
  /** Test seam: the live-check offer. Mirrors the auth confirm's shape. */
  confirmCheck?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the live check itself (default: `vendo doctor`). */
  runCheck?: (root: string) => Promise<boolean>;
  /** Uncertain-slot review — asked ONLY when the model reports uncertainty. */
  themeReview?: (summary: ThemeSummary) => Promise<Record<string, string>>;
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

/** The model writes these notes, at whatever length it likes, in its own first
    person — one ran to ~450 characters. On the rail the whole thing is a dim
    hint, so the FIRST sentence is the share that earns the space: it is the
    reading it chose, and the rest is the alternative it rejected (#1165). */
export function firstSentence(note: string): string {
  const end = /[.;](?:\s|$)/.exec(note);
  const head = (end === null ? note : note.slice(0, end.index)).trim();
  return head.length > 160 ? `${head.slice(0, 159).trimEnd()}…` : head;
}

/** The same review on the rail: a `◇` question per slot, the model's reasoning
    as a dim hint under it, and the `●` receipt — instead of a 450-character
    unstyled line at column 0, the one place the rail used to die (#1165). */
export function prettyThemeReview(pretty: Pick<PrettyOutput, "text">) {
  return async (summary: ThemeSummary): Promise<Record<string, string>> => {
    const overrides: Record<string, string> = {};
    for (const { slot, note } of summary.uncertain) {
      const answer = await pretty.text(
        `Theme ${slot} is uncertain — extracted ${summary.slots[slot]}. Replacement value, or Enter to keep`,
        firstSentence(note),
      );
      if (answer !== "") overrides[slot] = answer;
    }
    return overrides;
  };
}

/** Interactive review of model-flagged uncertain slots (the ONLY theme question). */
async function defaultThemeReview(summary: ThemeSummary): Promise<Record<string, string>> {
  if (!stdin.isTTY || !stdout.isTTY) return {};
  const prompt = createInterface({ input: stdin, output: stdout });
  const overrides: Record<string, string> = {};
  try {
    for (const { slot, note } of summary.uncertain) {
      const answer = (await prompt.question(
        `Theme ${slot} is uncertain (${note}); extracted ${summary.slots[slot]}. Replacement value, or Enter to keep: `,
      )).trim();
      if (answer !== "") overrides[slot] = answer;
    }
  } finally {
    prompt.close();
  }
  return overrides;
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


/** Relative, posix-style import specifier from the layout's directory to the
    project-root `.vendo/theme.json` — printed for the user's paste, never
    written by init. Returns null when the project EXPLICITLY disables
    resolveJsonModule, so the printed snippet compiles. */
async function themeImportSpecifier(root: string, layoutDir: string): Promise<string | null> {
  if (await resolveJsonModuleDisabled(root)) return null;
  const themeJson = join(root, ".vendo", "theme.json");
  return relative(layoutDir, themeJson).split(sep).join("/");
}

/** True only when tsconfig/jsconfig EXPLICITLY sets
    `compilerOptions.resolveJsonModule === false` — the one case where importing
    theme.json breaks the build. */
async function resolveJsonModuleDisabled(root: string): Promise<boolean> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const raw = await readOptional(join(root, file));
    if (raw === null) continue;
    try {
      const config = JSON.parse(raw) as { compilerOptions?: { resolveJsonModule?: boolean } };
      if (config.compilerOptions?.resolveJsonModule === false) return true;
    } catch {
      // Malformed config — assume the default (enabled).
    }
  }
  return false;
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

/**
 * The server-action wiring an EXISTING route is missing (ENG-248): a host that
 * adds `"use server"` actions AFTER the initial init gets vendo-actions.ts
 * generated, but its route.ts still calls `createVendo` without
 * `serverActions` — so every server-action call fails closed at runtime. Init
 * does not own a file it did not create, so this returns the developer's paste
 * rather than a rewrite. Null when there is nothing to say: the route already
 * passes a map (including one sourced from somewhere else — a local map, an
 * aliased import — which our import would only shadow), or the composition is
 * unrecognized and no honest two-line paste exists for it.
 */
function routeServerActionsEdit(source: string, file: string): ManualEdit | null {
  if (serverActionsWiring(source) !== "unwired") return null;
  return {
    file,
    lines: [
      ...(importsGeneratedMap(source) ? [] : [`import { serverActions } from "./vendo-actions";`]),
      `… then add inside createVendo({ … }): serverActions,`,
    ],
    why: "createVendo dispatches server-action tools through that map — without it every one of them fails closed at execution time (no work performed).",
  };
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
  const manifest = JSON.parse(raw) as Record<string, unknown>;
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

/** Read-only extraction for the agent plan. vendoSync writes its artifacts, so
    it runs against a throwaway out dir — the host tree stays untouched (the
    --agent contract). Existing overrides ride along so the plan reflects prior
    human risk decisions, mirroring vendoSync's own merge semantics. */
async function extractForPlan(root: string): Promise<{ tools: ExtractedTool[]; warnings: string[] }> {
  const out = await mkdtemp(join(tmpdir(), "vendo-agent-plan-"));
  try {
    const overridesRaw = await readOptional(join(root, ".vendo", "overrides.json"));
    if (overridesRaw !== null) await writeText(join(out, "overrides.json"), overridesRaw);
    const report = await vendoSync({ root, out });
    const file = JSON.parse(await readFile(join(out, "tools.json"), "utf8")) as { tools?: ExtractedTool[] };
    let overrides: OverridesFile | null = null;
    try {
      overrides = overridesRaw === null ? null : JSON.parse(overridesRaw) as OverridesFile;
    } catch {
      // vendoSync already validated the copy; an unreadable original merges as absent.
    }
    return { tools: mergeOverrides(file.tools ?? [], overrides), warnings: report.warnings };
  } catch (error) {
    // The plan must always emit — extraction failures degrade to a warning.
    return { tools: [], warnings: [`extraction failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** 04-actions §1 risk ladder projected as advice: destructive asks first,
    writes get reviewed, reads auto-run (no entry). */
function riskRecommendations(tools: ExtractedTool[]): RiskRecommendation[] {
  return tools.flatMap((tool) => {
    if (tool.disabled === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "extracted disabled (unclassifiable); enable it deliberately in .vendo/overrides.json after review" }];
    }
    if (tool.confirmEach === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "already marked confirmEach in .vendo/overrides.json; policy asks before running it" }];
    }
    if (tool.risk === "ungraded") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "nobody has graded this yet, so it asks on every call; run `vendo sync` with a model key, or grade it in .vendo/overrides.json" }];
    }
    if (tool.risk === "destructive") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "irreversible; mark it confirmEach in .vendo/overrides.json so policy asks first" }];
    }
    if (tool.risk === "write") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "writes host data; review it and mark confirmEach in .vendo/overrides.json when irreversible" }];
    }
    return [];
  });
}

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

/** The mount paste for a Next host, as data — ONE paste: `<VendoProvider>`
    around the app's client root. A host that already mounts a surface needs
    nothing. No overlay line: the chat bubble is an optional documented line,
    never something init prints. Null on Express and custom hosts: their wiring
    has no single host file to name, so it stays in the printed lines below. */
async function mountStep(root: string, layout: LayoutWiring): Promise<ManualEdit | null> {
  if (layout.kind === "already" || layout.kind === "express" || layout.kind === "custom") return null;
  const { file: entry, children } = await clientRoot(root);
  const entryDir = dirname(entry);
  const specifier = await themeImportSpecifier(root, entryDir);
  return {
    file: relative(root, entry),
    lines: [
      `import { VendoProvider } from "@vendoai/vendo/react";`,
      ...(specifier === null
        ? []
        : [
            `import theme from ${JSON.stringify(specifier)};`,
            `import type { VendoTheme } from "@vendoai/vendo";`,
          ]),
      `… then wrap: <VendoProvider baseUrl="/api/vendo"${specifier === null ? "" : " theme={theme as VendoTheme}"}>${children}</VendoProvider>`,
    ],
    why: "<VendoProvider> is what the @vendoai/ui hooks and embeds read; baseUrl is the wire mount, path prefix included. Until this lands, Vendo is wired but nothing on the page can reach it.",
  };
}

/** A manual edit as the compact printed/plan lines. */
function editLines(step: ManualEdit): string[] {
  return [`In ${step.file}:`, ...step.lines.map((line) => `  ${line}`), `  (${step.why})`];
}

/** Everything the run could not do itself: the mount paste plus, on Express
    and custom runtimes, their own two wiring lines. */
async function manualWiringLines(root: string, layout: LayoutWiring): Promise<string[]> {
  if (layout.kind === "express") {
    return [
      `app.use("/api/vendo", mountVendo());   // in your server`,
      `<VendoProvider baseUrl="/api/vendo" theme={theme}>…</VendoProvider>  // around your client root`,
    ];
  }
  if (layout.kind === "custom") {
    return [
      `Route your runtime's requests through the generated module — Cloudflare Workers: export default { fetch: (request, env) => handleVendoRequest(request, env) };`,
      `<VendoProvider baseUrl="/api/vendo" theme={theme}>…</VendoProvider>  // around your client root`,
      `Set VENDO_BASE_URL to the deployment's FULL public URL, path prefix included (credential forwarding fails closed without it).`,
    ];
  }
  const step = await mountStep(root, layout);
  return step === null ? [] : editLines(step);
}

/** The repo-specific agent tail (agent-install-dx): a non-interactive
    scaffold run is agent-driven, so the run ends with plain deterministic
    pointers — the wired auth preset and what is still stubbed about it, the
    exact files left to hand-edit (derived from what THIS run wrote, never
    canned prose), and the one doctor command that gates "done". A pointer to
    work, not documentation: the playbook carries the teaching. */
async function agentTailLines(args: {
  root: string;
  framework: Exclude<HostFramework, "unknown"> | "custom";
  compositionPath: string | null;
  authWired: AuthMatch | null;
  /** How far the visible-surface wiring got this run. */
  layout: LayoutWiring;
  /** No model credential resolved this run — the tail points the agent at
      the auth.md key flow (Agent Install DX, Layer 2). */
  cloudKeyMissing: boolean;
  /** Files that already existed, so init printed the change instead. */
  edits: ManualEdit[];
}): Promise<string[]> {
  const lines: string[] = [];
  // Auth is a tail fact only when a composition was created this run — a
  // re-run against an existing composition changed nothing about auth.
  if (args.compositionPath !== null) {
    if (args.authWired === null) {
      lines.push("auth: none wired — sessions stay anonymous until a preset is added");
    } else if (args.authWired.source === "picked") {
      lines.push(`auth: ${args.authWired.preset}() wired — stubbed: ${args.authWired.dependency} is not in package.json; install it before the first authenticated run`);
    } else {
      lines.push(`auth: ${args.authWired.preset}() wired (detected ${args.authWired.dependency})`);
    }
  }
  if (args.compositionPath !== null && args.authWired === null) {
    lines.push(`edit ${args.compositionPath} — add the auth preset named in the advisory above when the host has auth`);
  }
  if (args.framework === "express") {
    // No exact entry file exists to name on Express — point at the printed
    // wiring lines instead of guessing a path.
    lines.push("edit your server and client entries — paste the mountVendo() and <VendoProvider> lines above (without a mounted provider, nothing on the page can reach Vendo)");
  } else if (args.layout.kind === "manual") {
    const entry = relative(args.root, (await clientRoot(args.root)).file);
    lines.push(`edit ${entry} — wrap the app in the <VendoProvider> lines above (without it, nothing on the page can reach Vendo)`);
  }
  for (const edit of args.edits) {
    lines.push(`edit ${edit.file} — apply the change printed above yourself (it already exists, so init did not write it)`);
  }
  if (await readOptional(join(args.root, ".vendo", "brief.md")) === BRIEF_PLACEHOLDER) {
    lines.push(`edit ${join(".vendo", "brief.md")} — replace the placeholder with what this product does and for whom`);
  }
  if (args.cloudKeyMissing) {
    lines.push(`cloud key: none — for Vendo Cloud, fetch ${AUTH_MD_URL} and run \`vendo login\` (your human approves a code in the browser; the key lands in .env.local), then re-run init or pass --cloud-key <key>; --byo with a provider key also works`);
  }
  lines.push("gate: run `vendo doctor --json` — done when every check reports green");
  return lines;
}

const USE_CASE_OPTIONS: SelectOption[] = [
  { value: "embedded", label: "Embedded in my app — chat + generated UI", hint: "recommended" },
  { value: "agent-loop", label: "Through my own agent loop (AI SDK / Mastra)" },
  { value: "mcp", label: "From outside agents over MCP — Claude, ChatGPT, Cursor, or any MCP agent (experimental)" },
];

/** The run's FIRST question. Every path shares the same wired route, so a
    wrong pick costs nothing; the right one saves a docs round trip. --yes and
    non-interactive runs take "embedded" — today's behaviour, so no existing
    script changes shape. */
async function resolveUseCase(input: {
  options: InitOptions;
  pretty: PrettyOutput | null;
  interactive: boolean;
}): Promise<InitUseCase> {
  const { options, pretty, interactive } = input;
  if (options.useCase !== undefined) return options.useCase;
  if (options.yes === true || !interactive) return "embedded";
  const select = options.selectUseCase ?? (pretty === null ? plainSelect : pretty.select);
  const picked = await select("How will people use your agent?", USE_CASE_OPTIONS);
  return (INIT_USE_CASES as readonly string[]).includes(picked) ? picked as InitUseCase : "embedded";
}

const BASE_URL_PLACEHOLDER = "VENDO_BASE_URL=http://localhost:3000";

/** "Where will this deploy?" — one Enter to decline, and the answer replaces
    init's OWN placeholder in .env.example. Nowhere else: a production URL in
    .env.local would repoint local dev's discovery, callbacks and credential
    forwarding at the deployed origin, and dev already trusts the request's
    own origin. Returns the captured URL, or null when skipped. */
export async function captureBaseUrl(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
  interactive: boolean;
}): Promise<string | null> {
  const { root, options, output, pretty, interactive } = input;
  // plainText carries plainSelect's guard — a non-TTY input or output returns
  // the fallback and never prompts — so a piped run stays byte-identical while
  // a NO_COLOR terminal still gets the question. Making this pretty-only would
  // silently delete the feature for anyone who sets NO_COLOR.
  const ask = options.baseUrl !== undefined
    ? async () => options.baseUrl!
    : options.askText
      ?? (options.yes === true || !interactive ? undefined : (pretty === null ? plainText : pretty.text));
  if (ask === undefined) return null;
  const url = (await ask("Where will this deploy?", "e.g. https://app.acme.com — Enter to skip")).trim();
  if (url === "") return null;
  const path = join(root, ".env.example");
  const current = await readOptional(path);
  if (current === null || !current.includes(BASE_URL_PLACEHOLDER)) return url;
  await writeText(path, current.replace(BASE_URL_PLACEHOLDER, `VENDO_BASE_URL=${url}`));
  output.log("written to .env.example — set it in your deploy platform's env");
  return url;
}

/** The footer's stats. It never claims more than the run achieved: an
    outstanding paste renders "1 paste left", never "agent live". */
export function runStats(input: {
  toolCount: number;
  brandCaptured: boolean;
  handSteps: number;
  checkPassed: boolean;
}): string {
  return [
    `${input.toolCount} tool${input.toolCount === 1 ? "" : "s"}`,
    ...(input.brandCaptured ? ["brand captured"] : []),
    input.handSteps > 0
      ? `${input.handSteps} paste${input.handSteps === 1 ? "" : "s"} left`
      : input.checkPassed ? "agent live" : "wired",
  ].join(" · ");
}

/** Variant B — the user's own agent loop. Which snippet prints is read off
    the same package.json init already parses (`ai` → AI SDK, `@mastra/core`
    → Mastra); the generated route stays either way, because it is what
    serves apps and approvals to the embeds. Mastra's principal step is a
    step of its own, not a footnote: vendoMastraTools reads the principal off
    the request context and a call without one fails closed. */
async function agentLoopSteps(root: string): Promise<ManualEdit[]> {
  let dependencies: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    // No readable manifest — neither snippet is honest, so print neither.
  }
  if (Object.hasOwn(dependencies, "@mastra/core")) {
    return [
      {
        file: join("src", "mastra", "agents", "<your-agent>.ts"),
        lines: [
          `import { vendoMastraTools } from "@vendoai/vendo/mastra";`,
          `… then spread the pack: tools: async () => ({ ...yourTools, ...(await vendoMastraTools(vendo)) })`,
        ],
        why: "Your loop, your model — Vendo adds guarded vendo_* tools, vendo_make (inline micro-apps) and vendo_delegate. https://docs.vendo.run/existing-agents/mastra",
      },
      {
        file: join("app", "api", "chat", "route.ts"),
        lines: [
          `import { VENDO_PRINCIPAL_KEY } from "@vendoai/vendo/mastra";`,
          `… then set the per-request principal: requestContext.set(VENDO_PRINCIPAL_KEY, principal);`,
        ],
        why: "vendoMastraTools reads the principal off the request context — a call without one fails closed, so an install that skips this looks broken at the first tool call.",
      },
    ];
  }
  if (Object.hasOwn(dependencies, "ai")) {
    return [{
      file: join("app", "api", "chat", "route.ts"),
      lines: [
        `import { vendoTools } from "@vendoai/vendo/ai-sdk";`,
        `… then inside streamText: tools: { ...yourTools, ...(await vendoTools(vendo, { principal })) }`,
      ],
      why: "Your loop, your model — Vendo adds guarded vendo_* tools, vendo_make (inline micro-apps) and vendo_delegate. https://docs.vendo.run/existing-agents/ai-sdk",
    }];
  }
  return [];
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
 *  code. It never discovers posture and never reaches a broker — it prints
 *  environment lines for the operator, exactly as the console would.
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
  baseUrl: string | null;
}): Promise<ReturnType<typeof planMcp> | null> {
  const { root, options, output, pretty, interactive, changes, framework, authWired, cloudKey, baseUrl } = input;
  const ask = options.yes === true || !interactive;

  let posture: McpPosture = options.posture ?? "local";
  if (options.posture === undefined && cloudKey && !ask) {
    const select = options.selectUseCase ?? (pretty === null ? plainSelect : pretty.select);
    posture = (await select("How should outside agents sign in?", POSTURE_OPTIONS)) as McpPosture;
  }

  let serviceKey = options.serviceKey === true;
  if (options.serviceKey === undefined && !ask) {
    const confirm = options.confirmAuth ?? (pretty === null ? askYesNo : pretty.confirm);
    serviceKey = await confirm("Will your own backend call these tools machine-to-machine?", false);
  }

  const mcp = planMcp({
    root,
    appDir: await appDirectory(root),
    framework,
    authWired,
    serverActions: (await requiredServerActions(root)).length > 0,
    cloudKey,
    posture,
    serviceKey,
    // Not optional: a null base URL is an ANSWER the plan reads, and it is
    // what makes steps[] lead with the recoverable version of E-MCP-009's
    // failure instead of assuming an origin.
    baseUrl,
  });
  if (mcp.blocked !== undefined) {
    // Nothing MCP was written and the reason says what to do about it. The
    // rest of the install stands — this is an advisory, not a failure.
    output.error(`warning: ${mcp.blocked}`);
    return null;
  }
  // The route init is already CREATING becomes the MCP one — same file, the
  // thin body over the composition module. The planner cannot know whether
  // that file exists, so it hands back the source and the caller pushes it
  // with the `before` it already read; a route init did not write this run
  // has no planned change here and is left alone, as always.
  const route = changes.find((change) => change.before === null && change.path.endsWith(`${sep}route.ts`));
  if (route !== undefined && mcp.routeSource !== null) {
    route.after = mcp.routeSource;
    route.diff = diff(route.path, null, mcp.routeSource);
  }
  // The composition module and the origin-root discovery route are both new.
  for (const change of mcp.changes) {
    if (changes.some((planned) => planned.absolute === change.absolute)) continue;
    changes.push({
      absolute: change.absolute,
      path: change.path,
      before: null,
      after: change.after,
      diff: diff(change.path, null, change.after),
    });
  }
  if (mcp.serviceKeyValue !== undefined) {
    await upsertEnvLocal(root, "VENDO_SERVICE_KEY", mcp.serviceKeyValue);
    output.log(`Generated VENDO_SERVICE_KEY → .env.local (…${mcp.serviceKeyValue.slice(-4)})`);
    await ensureEnvLocalIgnored(root, output);
  }
  return mcp;
}

/** The live check — `vendo doctor`, the one thing that turns "wired" into
 *  "proven". It only OFFERS itself when the run owes no hand step: doctor
 *  grades whether the <VendoProvider> paste landed, and the paste happens
 *  after init exits, so offering it on a run that still owes one would fail a
 *  run that did nothing wrong. Nothing here can change init's exit code. */
async function offerLiveCheck(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
  interactive: boolean;
}): Promise<boolean> {
  const { root, options, output, pretty, interactive } = input;
  try {
    if (options.check === false) return false;
    if (options.check !== true) {
      const confirm = options.confirmCheck
        ?? (options.yes === true || !interactive || stdin.isTTY !== true
          ? undefined
          : (pretty === null ? askYesNo : pretty.confirm));
      if (confirm === undefined) return false;
      if (!(await confirm("Start your dev server and run a live check now?", true))) return false;
    }
    pretty?.spin("vendo doctor — starting dev server…");
    const check = options.runCheck ?? (async (target: string) =>
      (await runDoctor({ targetDir: target, yes: true, output })) === 0);
    const passed = await check(root);
    pretty?.stopSpin();
    output.log(passed
      ? "Live turn passed — your door answers"
      : "The live check did not pass — `npx vendo doctor` prints what is missing.");
    return passed;
  } catch {
    // Best-effort by design: init already succeeded.
    pretty?.stopSpin();
    return false;
  }
}

/** Whether the visible surface is already mounted in the host's own source —
    drives the mount paste and the agent tail. Init never edits those files, so
    there is no "wired by init" state: the only question is what is left for
    the developer to paste. */
type LayoutWiring =
  /** A Vendo mount already exists — nothing to do or say. */
  | { kind: "already" }
  /** Nothing mounts Vendo yet — the printed paste is the step. */
  | { kind: "manual" }
  /** Express hosts keep their two printed wiring lines. */
  | { kind: "express" }
  /** Custom-runtime hosts (--framework custom): the generated module's two
      printed wiring lines — route requests through it, mount the client. */
  | { kind: "custom" };

/** What one framework's composition branch contributes to the plan: the files
 *  init will create, the pastes it can only describe, and the auth facts the
 *  agent tail reports. */
interface ScaffoldPlan {
  changes: PlannedChange[];
  edits: ManualEdit[];
  authAdvice: string | null;
  authWired: AuthMatch | null;
  compositionPath: string | null;
  layout: LayoutWiring;
}

const emptyScaffold = (layout: LayoutWiring): ScaffoldPlan => ({
  changes: [],
  edits: [],
  authAdvice: null,
  authWired: null,
  compositionPath: null,
  layout,
});

async function planCustomComposition(
  root: string,
  options: InitOptions,
  confirmAuth?: ConfirmAuth,
  selectAuth?: SelectAuth,
): Promise<ScaffoldPlan> {
  const scaffold = emptyScaffold({ kind: "custom" });
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
  const scaffold = emptyScaffold({ kind: "express" });
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
  const missing = missingRegistrations(actionsBefore, registrations);
  if (missing.length > 0) {
    scaffold.edits.push({
      file: path,
      lines: missingRegistrationLines(root, dirname(actionsModule), actionsBefore, missing),
      why: `${missing.length} action${missing.length === 1 ? "" : "s"} the host exposes ${missing.length === 1 ? "is" : "are"} not registered here — ${missing.length === 1 ? "it fails" : "each one fails"} closed at execution time (no work performed). The rest of the file is yours; nothing else needs to change.`,
    });
  }
}

async function planNextComposition(
  root: string,
  options: InitOptions,
  confirmAuth?: ConfirmAuth,
  selectAuth?: SelectAuth,
): Promise<ScaffoldPlan> {
  const scaffold = emptyScaffold({ kind: "manual" });
  const app = await appDirectory(root);
  const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
  const actionsModule = join(app, "api", "vendo", "[...vendo]", "vendo-actions.ts");
  const routeBefore = await readOptional(route);
  const actionsBefore = await readOptional(actionsModule);
  const registrations = await requiredServerActions(root);
  // …and the map exists only for a route that will CONSUME it: the one being
  // created now, one that already imports ./vendo-actions, or one init is
  // about to hand the import paste to. A route composing its own map never
  // grows an orphan — the same rule the registry above follows, and the same
  // shape doctor stays silent about.
  const mapConsumed = routeBefore === null
    || importsGeneratedMap(routeBefore)
    || serverActionsWiring(routeBefore) === "unwired";
  if (registrations.length > 0 && mapConsumed) {
    planServerActionsMap(scaffold, root, actionsModule, actionsBefore, registrations);
  }
  if (routeBefore === null) {
    const path = relative(root, route);
    // Detect + confirm happens only on fresh composition creation.
    const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
    const routeAfter = routeSource({ serverActions: registrations.length > 0, auth: auth.wired });
    scaffold.changes.push({ absolute: route, path, before: routeBefore, after: routeAfter, diff: diff(path, routeBefore, routeAfter) });
    scaffold.authAdvice = auth.advice;
    scaffold.authWired = auth.wired;
    scaffold.compositionPath = path;
  } else if (registrations.length > 0) {
    // The route already exists but server actions appeared since it was
    // generated: name the wiring the existing createVendo is missing, so
    // server-action execution stops failing closed (ENG-248).
    const edit = routeServerActionsEdit(routeBefore, relative(root, route));
    if (edit !== null) scaffold.edits.push(edit);
  }

  // Init never writes a client file, so the only question is whether the host
  // already mounts one. A host source that mounts the provider IS the mount.
  const mounts = await detectVendoWiring(root);
  if (mounts.client) scaffold.layout = { kind: "already" };
  return scaffold;
}

async function buildPlan(options: InitOptions, confirmAuth?: ConfirmAuth, selectAuth?: SelectAuth): Promise<{
  plan: InitPlan;
  changes: PlannedChange[];
  manualSteps: string[];
  /** The mount paste as data; null when a surface is already mounted or the
      host is Express/custom (their lines ride `manualSteps`). */
  mount: ManualEdit | null;
  /** Changes to files that already exist, which init therefore leaves alone. */
  edits: ManualEdit[];
  authAdvice: string | null;
  /** What the fresh composition wired (agent-tail fact); null when no
      composition was created this run OR it stayed anonymous. */
  authWired: AuthMatch | null;
  /** Relative path of the composition created THIS run; null otherwise. */
  compositionPath: string | null;
  /** How the visible surface reached (or didn't reach) the layout. */
  layout: LayoutWiring;
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
  const { changes, edits, authAdvice, authWired, compositionPath, layout } = scaffold;

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
    ".vendo/tools.json",
    ".vendo/overrides.json",
    ".vendo/policy.json",
    ".vendo/brief.md",
    ".vendo/theme.json",
    ".vendo/theme.extracted.json",
    ".vendo/data/.gitignore",
  ];
  const mount = await mountStep(root, layout);
  const manualSteps = [
    ...await manualWiringLines(root, layout),
    ...edits.flatMap(editLines),
  ];
  return {
    changes,
    edits,
    manualSteps,
    mount,
    authAdvice,
    authWired,
    compositionPath,
    layout,
    plan: {
      framework,
      // Only when the run named one: an unattended plan stays byte-identical
      // to the one agents parse today.
      ...(options.useCase === undefined ? {} : { useCase: options.useCase }),
      root,
      writes,
      codeChanges: changes.map(({ path, diff: rendered }) => ({ path, diff: rendered })),
      manualSteps,
      ...(mount === null ? {} : { mount }),
      ...(edits.length === 0 ? {} : { edits }),
    },
  };
}

async function writeIfMissing(path: string, content: string, force: boolean): Promise<void> {
  if (!force && await exists(path)) return;
  await writeText(path, content);
}

async function ensureVendoEnvExample(root: string): Promise<void> {
  const path = join(root, ".env.example");
  const current = await readOptional(path);
  if (current === null) {
    await writeText(path, VENDO_ENV_EXAMPLE);
    return;
  }
  if (/^\s*VENDO_BASE_URL\s*=/m.test(current)) return;
  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeText(path, `${current}${separator}${VENDO_ENV_EXAMPLE}`);
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
 *  consent was declined or unavailable, `themeDraft` is simply null
 *  and the exact-only summary stands — then --theme answers (a human
 *  "(you)" wins over a model value), the one-glance palette print, and
 *  finally the uncertain-slot review. */
async function finalizeTheme(input: {
  themeSummary: ThemeSummary;
  themeDraft: SyncFlowResult["themeDraft"];
  themePath: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
}): Promise<void> {
  const { themeSummary, themeDraft, themePath, options, pretty, output } = input;
  const summary = themeDraft === null ? themeSummary : applyThemeDraft(themeSummary, themeDraft);
  // --theme answers land first; the review prompt then covers only the
  // uncertain slots the flags left unanswered (non-interactive runs keep
  // the extracted/merged values for those, exactly as before).
  const answers: Record<string, string> = { ...(options.themeAnswers ?? {}) };
  const unanswered = summary.uncertain.filter((entry) => !Object.hasOwn(answers, entry.slot));
  if (unanswered.length > 0 && options.yes !== true) {
    const review = options.themeReview
      ?? (pretty === null ? defaultThemeReview : prettyThemeReview(pretty));
    const reviewed = await review(
      unanswered.length === summary.uncertain.length ? summary : { ...summary, uncertain: unanswered },
    );
    for (const [slot, raw] of Object.entries(reviewed)) {
      if (!Object.hasOwn(answers, slot)) answers[slot] = raw;
    }
  }
  if (Object.keys(answers).length > 0) applyThemeAnswers(summary, answers, output);
  await writeText(themePath, `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
  printThemeSummary(summary, output);
}

/** Done — the pastes init cannot take (it only ever CREATES files in your
 *  source tree), then their own dev server. They get their own framed block
 *  because skipping them is the whole failure mode: a green install nobody
 *  can see, or server-action tools that silently fail closed. */
function printClosingSteps(input: {
  output: Output;
  handSteps: ManualEdit[];
  manualSteps: string[];
  credential: DevCredential;
  cloud: { keyValid: boolean };
  compositionPath: string | null;
}): void {
  const { output, handSteps, manualSteps, credential, cloud, compositionPath } = input;
  if (handSteps.length > 0) {
    const rule = "─".repeat(64);
    output.log(`\n${rule}`);
    output.log(handSteps.length === 1
      ? "ONE STEP LEFT — paste this yourself (init never edits your files)"
      : `${handSteps.length} STEPS LEFT — paste these yourself (init never edits your files)`);
    for (const step of handSteps) {
      output.log(`\n  File: ${step.file}`);
      for (const line of step.lines) output.log(`    ${line}`);
      output.log(`\n  ${step.why}`);
    }
    // No `Then confirm it landed: npx vendo doctor` here: the ending below
    // already names doctor, six lines down, and saying it twice is the
    // duplication the redesign set out to remove (#1164).
    output.log(rule);
  }
  // Express and custom hosts have no single host file to name, so their
  // wiring keeps the compact list; the block above already said everything
  // a Next host needs, and nothing is printed twice.
  if (handSteps.length === 0 && manualSteps.length > 0) {
    output.log("\nLast steps are yours:");
    for (const line of manualSteps) output.log(`  ${line}`);
  }
  // A run without a USABLE model credential is wired but not answering, so
  // the closing line must not claim otherwise. The rung alone is not that
  // answer: resolveDevCredential only checks that VENDO_API_KEY is non-blank
  // (and VENDO_DEV_CREDENTIAL=vendo-cloud pins the rung with no key at all),
  // so a malformed key resolves "vendo-cloud" while the cloud step — the one
  // thing that inspected the key — already said it is not usable. Keyless,
  // the composition decides: one written THIS run passes no model, so "no
  // key" is the whole story, while one init did not write may pass its own
  // `model` to createVendo — nothing here can see that, so state the
  // condition rather than guess either way.
  // …and it only gets to speak at all once nothing is outstanding: a paste
  // still pending means the frame above just said Vendo is invisible until
  // it lands, so "the agent is live in your app" would contradict it in the
  // same breath (self-serve audit F5).
  const modelReady = credential.rung === "env-key"
    || (credential.rung === "vendo-cloud" && cloud.keyValid);
  if (handSteps.length === 0) {
    output.log(`\nThen start your dev server — ${modelReady
      ? "the agent is live in your app."
      : compositionPath !== null
        ? "the agent is live once you add a model key."
        : "no model key resolved here, so the agent is live only if your composition passes its own model."}`);
  }
  output.log(`${handSteps.length === 0 ? "" : "\n"}Verify everything: \`npx vendo doctor\` (it can start the server and run a live turn).`);
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
      "Pass --framework. Examples: vendo init --yes --framework next · --framework custom (any Web-standard runtime: Cloudflare Workers, Bun, Hono, ...)",
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
  // Dev keys may live in .env.local rather than this process's env — a
  // PRIOR run's minted starter key, or hand-added provider keys. Merge
  // them into the env every credential consumer reads (credential ladder,
  // cloud step, theme model pass, AI polish); an explicit env value
  // always wins over .env.local.
  let effectiveEnv = env;
  for (const name of [...ENV_KEY_VARS.map((entry) => entry.envVar), "VENDO_API_KEY"]) {
    if ((env[name] ?? "").trim() !== "") continue;
    const stored = envFileValueSync(root, name);
    if (stored !== null) effectiveEnv = { ...effectiveEnv, [name]: stored };
  }
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
}): Promise<number> {
  const { root, changes, force } = input;
  const wiringStarted = Date.now();
  for (const change of changes) {
    await writeText(change.absolute, change.after);
  }

  await ensureVendoEnvExample(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
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
}): Promise<SyncFlowResult> {
  const { root, output, options, pretty } = input;
  // `--extract` is the test seam onto the flow's judgment step, in init's own
  // flat spelling; where it overlaps a real flag, the seam wins.
  const extract = options.extract ?? {};
  const ai = extract.ai ?? options.ai;
  const engine = extract.engine ?? options.engine;
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
    // --ai IS the consent (no prompt, non-interactive runs stop skipping);
    // --no-ai is the refusal. No flag = ask, every interactive run.
    ...(ai === undefined ? {} : { ai }),
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
  pretty: PrettyOutput | null;
  interactive: boolean;
  credential: DevCredential;
}): Promise<void> {
  const { root, output, options, pretty, interactive, credential } = input;
  // #1153: the scaffolds this run wrote import `@vendoai/vendo/*`, and a host
  // installed under the `vendoai` alias alone cannot resolve them under pnpm's
  // strict node_modules — the route fails to COMPILE and every request 500s.
  await ensureVendoPackage({
    root,
    output,
    ...(options.installVendo === undefined ? {} : { run: options.installVendo }),
  });

  // The credential's runtime provider must be resolvable from the host or
  // the FIRST turn 500s (dev-creds/model.ts loads it host-side; nothing
  // declares @ai-sdk/* — 0.4.1 E2E cert finding). Install exactly what the
  // resolved credential needs; a failure degrades to the manual command.
  await ensureProviderDeps({
    root,
    credential,
    output,
    ...(options.installProvider === undefined ? {} : { run: options.installProvider }),
  });

  // FINDINGS F2 (skateshop): a host pinning zod < 3.25 builds red once the
  // wiring pulls ai@6 into the bundle (ai imports the zod/v3 + zod/v4
  // subpaths that arrive in 3.25, and the host's own pin wins the installed
  // tree). Ask-and-bump with the auth confirm's interactivity posture:
  // --yes performs the announced bump, non-interactive prints the command.
  await ensureZodFloor({
    root,
    output,
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.yes === true || !interactive
      ? {}
      : { confirm: options.confirmZodBump ?? (pretty === null ? askYesNo : pretty.confirm) }),
    ...(options.installZod === undefined ? {} : { run: options.installZod }),
  });
}

/** The run's ending, as its own phase — the same reason wireAndScaffold and
 *  resolveModelCredential are their own functions. The last question, then
 *  everything still the user's to paste, then the live check on the runs that
 *  owe nothing, and finally the stats the footer carries. Returns those stats;
 *  it never decides the exit code. */
async function finishRun(input: {
  root: string;
  options: InitOptions;
  output: Output;
  pretty: PrettyOutput | null;
  interactive: boolean;
  useCase: InitUseCase;
  mcp: ReturnType<typeof planMcp> | null;
  mount: ManualEdit | null;
  edits: ManualEdit[];
  manualSteps: string[];
  credential: DevCredential;
  cloud: { keyValid: boolean };
  compositionPath: string | null;
  framework: Exclude<HostFramework, "unknown"> | "custom";
  authWired: AuthMatch | null;
  layout: LayoutWiring;
  toolCount: number;
  brandCaptured: boolean;
}): Promise<string> {
  const {
    root, options, output, pretty, interactive, useCase, mcp, mount, edits, manualSteps,
    credential, cloud, compositionPath, framework, authWired, layout, toolCount, brandCaptured,
  } = input;

  // Where will this deploy? — every path but MCP, which needed the answer
  // before it wrote. One Enter declines and the placeholder stands. The answer
  // is written to .env.example inside, so there is nothing to read back here.
  if (useCase !== "mcp") await captureBaseUrl({ root, options, output, pretty, interactive });

  // Variant B: the wired route stays (it serves apps and approvals to the
  // embeds) — what is added is the one snippet for their own loop.
  const handSteps = [
    ...(mount === null ? [] : [mount]),
    ...edits,
    ...(useCase === "agent-loop" ? await agentLoopSteps(root) : []),
  ];
  printClosingSteps({ output, handSteps, manualSteps, credential, cloud, compositionPath });
  if (mcp !== null) {
    const lines = [...mcp.steps, ...mcp.envLines];
    if (pretty === null) for (const line of lines) output.log(`  ${line}`);
    else pretty.block("Steps that are yours", lines, "◇");
  }

  // The live check offers itself ONLY when nothing is left to paste: doctor
  // grades the paste, and the paste happens after init exits.
  const checkPassed = handSteps.length === 0
    && await offerLiveCheck({ root, options, output, pretty, interactive });

  // Agent tail (agent-install-dx): the --yes-or-non-TTY path is agent-driven
  // — the run's FINAL block is the repo-specific pointers an agent parses.
  // Interactive human runs keep the clack-style output untouched; --agent
  // never reaches here (its read-only JSON plan returned above).
  if (options.yes === true || !interactive) {
    output.log("\nAgent tail:");
    const tail = await agentTailLines({ root, framework, compositionPath, authWired, layout, edits, cloudKeyMissing: credential.rung === "none" });
    for (const line of tail) output.log(`  ${line}`);
  }
  // The run's LAST word is the outstanding paste (self-serve audit F5: the
  // one step that matters used to scroll off-screen). The frame itself stays
  // up-screen — the agent tail's "the lines above" pointers depend on that
  // order — so the closer is a one-line echo of it, not a second copy. A human
  // terminal has the paste block six lines up and legible, and gets the count
  // in the footer instead.
  if (handSteps.length > 0 && pretty === null) {
    output.log(handSteps.length === 1
      ? `\n→ Don't forget the paste in ${handSteps[0]!.file} (frame above)`
      : `\n→ Don't forget the ${handSteps.length} pastes above (frame above)`);
  }
  return runStats({ toolCount, brandCaptured, handSteps: handSteps.length, checkPassed });
}

export async function runInit(options: InitOptions): Promise<number> {
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

  if (options.agent === true) {
    // Extraction runs before the plan is emitted so the plan carries real tool
    // names and risk advice; the throwaway out dir keeps --agent read-only.
    const { plan } = await buildPlan(options);
    const extraction = await extractForPlan(root);
    output.log(JSON.stringify({
      ...plan,
      extraction,
      riskRecommendations: riskRecommendations(extraction.tools),
    } satisfies InitPlan, null, 2));
    return 0;
  }

  // Detect + confirm (interactive runs only): --yes and non-interactive runs
  // accept the detected default silently — the same interactivity posture as
  // the AI-polish consent.
  const interactive = options.interactive
    ?? (!invokedByPackageScript() && Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  if (!await guardUndetectedFramework({ root, options, output, interactive })) return 1;

  // The read-back first: every fact below is already detected for other
  // reasons, and showing it is the moment the tool proves it looked.
  if (pretty !== null) {
    // Detect FIRST, print second: the banner's arrival plays over this work.
    // It reads a handful of files, though, so the arrival is the longer of the
    // two — awaiting the remainder is what makes it an arrival instead of a
    // flash, and it is bounded by the frame budget (~1.3s), not by this run.
    const stack = await stackLines(root, await resolveFramework(root, options));
    await pretty.arrived;
    pretty.block("Your stack", stack);
  }
  const useCase = await resolveUseCase({ options, pretty, interactive });

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
  const { plan, changes, edits, manualSteps, mount, authAdvice, authWired, compositionPath, layout } = await buildPlan(options, confirmAuth, selectAuth);
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

    // The MCP door derives every discovery URL from VENDO_BASE_URL and both
    // extra answers change the composition's own source, so that path needs
    // all three BEFORE it writes. Every other path asks the URL at the end,
    // where it is one Enter to decline.
    let mcp: ReturnType<typeof planMcp> | null = null;
    if (useCase === "mcp") {
      const baseUrl = await captureBaseUrl({ root, options, output, pretty, interactive });
      mcp = await planMcpScaffold({
        root, options, output, pretty, interactive, changes, baseUrl,
        framework: plan.framework, authWired, cloudKey: cloud.keyValid,
      });
    }

    pretty?.spin("Wiring your app…");
    const wiringMs = await wireAndScaffold({ root, changes, force: options.force === true });
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
    const flow = await runInstallSyncFlow({ root, output, options, pretty });
    const engineMs = Date.now() - engineStarted;
    const { themeSummary, counts: { tools: toolCount, routes: routeCount } } = flow;

    // Theme finalization (Task 4): merge whatever the AI pass filled — if
    // consent was declined or unavailable, `flow.themeDraft` is simply null
    // and the exact-only summary stands — then --theme answers (a human
    // "(you)" wins over a model value), the one-glance palette print, and
    // finally the uncertain-slot review. Skipped entirely when theme.json
    // pre-existed this run (the flow reconciles that one instead).
    if (themeSummary !== null) {
      await finalizeTheme({ themeSummary, themeDraft: flow.themeDraft, themePath, options, output, pretty });
    }

    // Judgment state, one line: a pass that ran already narrated itself (it
    // owns the judged/queued/rejected counts); otherwise say so honestly.
    if (!flow.judged.ran) {
      output.log("judgment: structural-only — only protocol facts are graded, so every ungraded tool asks on each call (add a model key and run `vendo sync` to grade the catalog)");
    }

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

    await ensureHostDeps({ root, output, options, pretty, interactive, credential });

    // The one short Cloud reminder in the end-of-run summary — ONLY while no
    // key exists (the full emphasized block already ran up top; no repeat).
    if (credential.rung === "none") {
      output.log("No model key yet: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY in .env.local, or run `vendo login` for a free dev key.");
    }

    // #478 short-term — npm installs the ai@7 peer conflict without failing
    // and every internal turn then throws AI_InvalidPromptError; warn in the
    // end-of-run summary instead of waiting for doctor to fail (E-DEP-001).
    const aiVersion = await installedAiVersion(root);
    if (aiVersion !== null && Number.parseInt(aiVersion, 10) >= 7) {
      output.error(`warning: installed ai@${aiVersion} is unsupported — Vendo supports ai@6; downgrade (npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3) or track github.com/runvendo/vendo/issues/478`);
    }

    // Called on its OWN line, never inside `pretty?.done(…)`: optional
    // chaining short-circuits its arguments, so a null `pretty` — every
    // non-TTY run — would skip the entire ending without a trace.
    const stats = await finishRun({
      root, options, output, pretty, interactive, useCase, mcp, mount, edits, manualSteps,
      credential, cloud, compositionPath, framework: plan.framework, authWired, layout,
      toolCount, brandCaptured: themeSummary !== null,
    });
    pretty?.done(Date.now() - started, true, stats);
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
