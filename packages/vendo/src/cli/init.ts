import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtractedTool, OverridesFile } from "@vendoai/actions";
import { mergeOverrides, vendoSync } from "@vendoai/actions/sync";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { VendoTheme } from "@vendoai/core";
import { scrubErrorDetail, type Telemetry } from "@vendoai/telemetry";
import { detectDepVersions, installedAiVersion } from "./dep-versions.js";
import { AUTH_MD_URL, runCloudStep, upsertEnvLocal, warnEnvLocalNotIgnored, type CloudStepOptions } from "./cloud-init.js";
import { runInitJudgment, type InitJudgmentOptions } from "./init-judgment.js";
import { BRIEF_TEMPLATE } from "./extract/stages.js";
import { ENV_KEY_VARS, resolveDevCredential, describeDevCredential, type DevCredential } from "../dev-creds/resolve.js";
import { detectFramework, detectVendoWiring, workspaceHostCandidates, type HostFramework } from "./framework.js";
import { resolveScaffoldAuth, type AuthMatch, type AuthPresetName, type ConfirmAuth, type SelectAuth } from "./init-auth.js";
import { ensureProviderDeps, ensureZodFloor, type InstallRunner } from "./provider-deps.js";
import {
  customServerSource,
  expressServerSource,
  importsGeneratedMap,
  missingRegistrationLines,
  missingRegistrations,
  registrySource,
  requiredServerActions,
  routeSource,
  serverActionsModuleSource,
  serverActionsWiring,
  VENDO_ENV_EXAMPLE,
  vendoRootWrapperSource,
} from "./init-scaffolds.js";
import { createPrettyOutput, plainSelect, usePrettyOutput, type PrettyOutput, type SelectOption } from "./pretty.js";
import { contrastingText } from "./theme/color.js";
import {
  applyThemeDraft,
  extractTheme as extractThemeSlots,
  validateSlotValue,
  type ThemeSlotValues,
  type ThemeSummary,
} from "./theme/extract-theme.js";
import { baseFrom, writeBase } from "./theme/provenance.js";
import {
  askYesNo,
  cloudProjectProps,
  consoleOutput,
  envLocalValueSync,
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
 *   scan → wire (the surface files — empty vendo/registry.tsx, the client
 *   mount vendo/vendo-root.tsx, the catch-all handler wired to the registry;
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

const DEFAULT_RADIUS = { small: "4px", large: "12px" } as const;

const BRIEF_PLACEHOLDER = `${BRIEF_TEMPLATE}\n`;

/** Slot values → the frozen runtime VendoTheme contract. Exported so the try
 *  surface's deterministic pass (cli/try/extract.ts) writes theme.json with
 *  the EXACT conversion init uses — one derivation law, never two. */
export function toVendoTheme(slots: ThemeSlotValues): VendoTheme {
  const deriveRadius = (factor: number, fallback: string): string => {
    const value = slots.radius.match(/^(\d+(?:\.\d+)?)px$/)?.[1];
    return value === undefined ? fallback : `${Number(value) * factor}px`;
  };
  return {
    colors: {
      background: slots.background,
      surface: slots.surface,
      text: slots.text,
      muted: slots.mutedText,
      accent: slots.accent,
      accentText: slots.accentText,
      danger: slots.danger,
      border: slots.border,
    },
    typography: {
      fontFamily: slots.fontFamily,
      headingFamily: slots.headingFamily,
      baseSize: slots.baseSize,
    },
    radius: {
      small: deriveRadius(0.5, DEFAULT_RADIUS.small),
      medium: slots.radius,
      large: deriveRadius(1.5, DEFAULT_RADIUS.large),
    },
    density: slots.density,
    motion: slots.motion,
  };
}

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

export interface InitPlan {
  framework: Exclude<HostFramework, "unknown"> | "custom";
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
  /** Test seam: the zod-floor bump confirm (provider-deps.ts, FINDINGS F2),
      asked only in interactive runs. Mirrors the auth confirm's shape. */
  confirmZodBump?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the zod-floor bump install subprocess. */
  installZod?: InstallRunner;
  /** Test seam (ENG-339): cloud-in-init step overrides. */
  cloud?: Partial<Omit<CloudStepOptions, "root" | "output" | "yes" | "credential">>;
  /** Test seam: judgment step overrides (harnesses, consent). */
  extract?: Partial<Omit<InitJudgmentOptions, "root" | "output" | "yes" | "env">>;
  /** Test seam: the detect+confirm auth question, asked only in interactive
      runs when exactly one auth family is detected and init is creating the
      composition. Mirrors the AI-polish consent's confirm shape. */
  confirmAuth?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the auth picker shown when the confirm is declined or when
      several families are detected. Receives the choice list (value/label/
      hint) and resolves the chosen value. */
  selectAuth?: (question: string, options: SelectOption[]) => Promise<string>;
  /** Test seam: interactivity override for the auth confirm (default: TTY),
      mirroring the judgment step's `interactive`. */
  interactive?: boolean;
  /** Test seam: the star ask — the ONE consent question that ends a fully
      successful interactive run. Mirrors the auth confirm's shape. */
  confirmStar?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the gh spawn behind a "yes" to the star ask. */
  spawnStar?: (command: string, args: string[]) => StarProcess;
  /** Uncertain-slot review — asked ONLY when the model reports uncertainty. */
  themeReview?: (summary: ThemeSummary) => Promise<Record<string, string>>;
}

const THEME_PALETTE_SLOTS = ["accent", "background", "surface", "text", "mutedText", "border", "danger"] as const;

/** ANSI truecolor swatch when interactive; plain hex otherwise. */
function swatch(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match || !stdout.isTTY) return "";
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(match[1]!.slice(index, index + 2), 16));
  return `\u001b[48;2;${r};${g};${b}m  \u001b[0m `;
}

/** One-glance confirm (§B2): the extracted palette, where each slot came
    from is visible in defaulted/errors, and theme.json stays the editable
    source of truth. */
function printThemeSummary(summary: ThemeSummary, output: Output): void {
  const palette = THEME_PALETTE_SLOTS
    .map((slot) => `${swatch(summary.slots[slot])}${slot} ${summary.slots[slot]}`)
    .join(" · ");
  output.log(`Theme: ${palette}`);
  const headings = summary.slots.headingFamily === summary.slots.fontFamily
    ? ""
    : ` · headings ${summary.slots.headingFamily}`;
  output.log(`Type: ${summary.slots.fontFamily}${headings} · radius ${summary.slots.radius}`);
  const missing = summary.defaulted.filter((slot) =>
    (THEME_PALETTE_SLOTS as readonly string[]).includes(slot) || slot === "fontFamily");
  if (missing.length > 0) {
    output.log(`No host evidence for ${missing.join(", ")} — neutral defaults used.`);
  }
  for (const error of summary.errors) output.error(`warning: ${error}`);
  output.log("Theme lives in .vendo/theme.json — edit it anytime; it is the source of truth.");
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

/** Where init scaffolds app/api/vendo/[...vendo] and (for a fresh scaffold)
    the app-router layout wrap. Next hard-fails ("pages and app directories
    should be under the same folder") when app/ and pages/ sit at different
    bases, so a host whose pages router already lives under src/ must get its
    NEW app/ segment there too, mirroring detectRouter's src/pages signal
    below — even before any src/app exists to detect directly. This still
    hands a pure-Pages host an App-Router route segment by design (valid in
    Next as long as both share one base); whether pages-native hosts deserve
    a pages/api scaffold instead is a separate, unaddressed question. */
async function appDirectory(root: string): Promise<string> {
  if (await exists(join(root, "src", "app"))) return join(root, "src", "app");
  if (await exists(join(root, "src", "pages"))) return join(root, "src", "app");
  return join(root, "app");
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

/** The file whose client root the <VendoRoot> paste belongs in, and the child
    expression it wraps there. A pages-only host has NO app/layout.tsx to wrap
    — its client root is pages/_app.tsx, and the generated vendo-root.tsx is a
    client component that mounts there unchanged. (Where the API route segment
    gets scaffolded is a separate, deliberate choice — see appDirectory.)
    Keyed on the layout FILE, not on detectRouter: the scaffold creates app/
    mid-run, and the answer must be the same before and after it. */
async function clientRoot(root: string): Promise<{ file: string; children: string }> {
  const layout = join(await appDirectory(root), "layout.tsx");
  if (!(await exists(layout))) {
    for (const pages of [join(root, "src", "pages"), join(root, "pages")]) {
      if (await exists(pages)) return { file: join(pages, "_app.tsx"), children: "<Component {...pageProps} />" };
    }
  }
  return { file: layout, children: "{children}" };
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

/** The mount paste for a Next host, as data. A host that already mounts a
    surface needs nothing; a <VendoRoot>-without-surface host needs the one
    overlay line; everyone else pastes the wrapper mount (the wrapper owns the
    registry/theme imports — pasting them into a Server Component layout is the
    RSC-serialization crash the wrapper exists to avoid). Null on Express and
    custom hosts: their wiring has no single host file to name, so it stays in
    the printed lines below. */
async function mountStep(root: string, layout: LayoutWiring, withRegistry: boolean): Promise<ManualEdit | null> {
  if (layout.kind === "already" || layout.kind === "express" || layout.kind === "custom") return null;
  if (layout.kind === "overlay-missing") {
    return {
      file: layout.layoutPath,
      lines: [
        `import { VendoOverlay } from "@vendoai/vendo/react";`,
        `… then add inside <VendoRoot>: <VendoOverlay />`,
      ],
      why: "<VendoRoot> is a context provider — it renders nothing. <VendoOverlay /> is the launcher pill + panel your users open.",
    };
  }
  const app = await appDirectory(root);
  const { file: entry, children } = await clientRoot(root);
  const entryDir = dirname(entry);
  if (withRegistry) {
    const wrapperSpecifier = relative(entryDir, join(dirname(app), "vendo", "vendo-root")).split(sep).join("/");
    return {
      file: relative(root, entry),
      lines: [
        `import { VendoRoot } from ${JSON.stringify(wrapperSpecifier)};`,
        `… then wrap: <VendoRoot>${children}</VendoRoot>`,
      ],
      why: `${join("vendo", "vendo-root.tsx")} mounts <VendoOverlay />, the visible launcher + panel — until this lands, Vendo is wired but invisible.`,
    };
  }
  // No registry consumer (a hand-wired route that ignores it): the direct
  // provider + overlay paste — theme.json is serializable, so it may cross
  // the Server Component boundary; the registry may not.
  const specifier = await themeImportSpecifier(root, entryDir);
  return {
    file: relative(root, entry),
    lines: [
      `import { VendoOverlay, VendoRoot } from "@vendoai/vendo/react";`,
      ...(specifier === null
        ? []
        : [
            `import theme from ${JSON.stringify(specifier)};`,
            `import type { VendoTheme } from "@vendoai/vendo";`,
          ]),
      `… then wrap: <VendoRoot${specifier === null ? "" : " theme={theme as VendoTheme}"}>${children}<VendoOverlay /></VendoRoot>`,
    ],
    why: "<VendoRoot> alone renders nothing — <VendoOverlay /> is the visible launcher + panel; until this lands, Vendo is wired but invisible.",
  };
}

/** A manual edit as the compact printed/plan lines. */
function editLines(step: ManualEdit): string[] {
  return [`In ${step.file}:`, ...step.lines.map((line) => `  ${line}`), `  (${step.why})`];
}

/** Everything the run could not do itself: the mount paste plus, on Express
    and custom runtimes, their own two wiring lines. */
async function manualWiringLines(root: string, layout: LayoutWiring, withRegistry: boolean): Promise<string[]> {
  if (layout.kind === "express") {
    const wrap = withRegistry
      ? `<VendoRoot components={registry} theme={theme}>…<VendoOverlay /></VendoRoot>`
      : `<VendoRoot theme={theme}>…<VendoOverlay /></VendoRoot>`;
    return [
      `app.use("/api/vendo", mountVendo());   // in your server`,
      `${wrap}  // around your client root (see vendo/server for the imports; <VendoOverlay /> is the visible launcher + panel)`,
    ];
  }
  if (layout.kind === "custom") {
    const wrap = withRegistry
      ? `<VendoRoot components={registry} theme={theme}>…<VendoOverlay /></VendoRoot>`
      : `<VendoRoot theme={theme}>…<VendoOverlay /></VendoRoot>`;
    return [
      `Route your runtime's requests through the generated module — Cloudflare Workers: export default { fetch: (request, env) => handleVendoRequest(request, env) };`,
      `${wrap}  // around your client root (see vendo/server for the imports; <VendoOverlay /> is the visible launcher + panel)`,
      `Set VENDO_BASE_URL to the deployed origin (credential forwarding fails closed without it).`,
    ];
  }
  const step = await mountStep(root, layout, withRegistry);
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
  registryPath: string | null;
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
  if (args.registryPath !== null) {
    lines.push(`edit ${args.registryPath} — register the components the agent may render (generated empty)`);
  }
  if (args.compositionPath !== null && args.authWired === null) {
    lines.push(`edit ${args.compositionPath} — add the auth preset named in the advisory above when the host has auth`);
  }
  if (args.framework === "express") {
    // No exact entry file exists to name on Express — point at the printed
    // wiring lines instead of guessing a path.
    lines.push("edit your server and client entries — paste the mountVendo() and <VendoRoot>/<VendoOverlay /> lines above (without a mounted surface, users see nothing)");
  } else if (args.layout.kind === "overlay-missing") {
    lines.push(`edit ${args.layout.layoutPath} — add <VendoOverlay /> inside your <VendoRoot> (see the lines above; <VendoRoot> alone renders NOTHING visible)`);
  } else if (args.layout.kind === "manual") {
    const entry = relative(args.root, (await clientRoot(args.root)).file);
    lines.push(`edit ${entry} — wrap the app in the <VendoRoot> lines above (it mounts <VendoOverlay />, the visible surface; without it users see nothing)`);
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

/** The slice of the spawned gh process the star step observes (injectable —
    tests drive it with a plain EventEmitter). */
export interface StarProcess {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
}

const STAR_REPO = "runvendo/vendo";
// Tracked star link (vendo-web star-worker): captures star_link_clicked
// {src: cli} server-side, then redirects to the repo.
const STAR_LINK = "https://vendo.run/star?src=cli";

/** Star the repo via gh (agent-install-dx §CLI-5). Every failure mode — gh
    not installed (spawn error), a non-zero exit, a throwing seam, or a gh
    that hangs past `timeoutMs` — is plain `false`: the caller prints the
    repo URL instead, one line, no error noise. Exported for the timeout's
    direct unit test only. */
export function starViaGh(spawnStar: NonNullable<InitOptions["spawnStar"]>, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolveStar) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (starred: boolean): void => {
      if (timer !== null) clearTimeout(timer);
      resolveStar(starred);
    };
    let child: StarProcess;
    try {
      child = spawnStar("gh", ["api", "-X", "PUT", `user/starred/${STAR_REPO}`]);
    } catch {
      settle(false);
      return;
    }
    timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
  });
}

/** Whether the visible surface is already mounted in the host's own source —
    drives the mount paste and the agent tail. Init never edits those files, so
    there is no "wired by init" state: the only question is what is left for
    the developer to paste. */
type LayoutWiring =
  /** The layout already mounts <VendoRoot> but no <VendoOverlay /> is
      mounted anywhere obvious — the one remaining paste is the overlay. */
  | { kind: "overlay-missing"; layoutPath: string }
  /** A Vendo mount already exists — nothing to do or say. */
  | { kind: "already" }
  /** Nothing mounts Vendo yet — the printed paste is the step. */
  | { kind: "manual" }
  /** Express hosts keep their two printed wiring lines. */
  | { kind: "express" }
  /** Custom-runtime hosts (--framework custom): the generated module's two
      printed wiring lines — route requests through it, mount the client. */
  | { kind: "custom" };

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
  /** Relative path of the registry generated THIS run; null otherwise. */
  registryPath: string | null;
  /** How the visible surface reached (or didn't reach) the layout. */
  layout: LayoutWiring;
}> {
  const root = resolve(options.targetDir);
  // "unknown" detection lands on the runtime-neutral custom scaffold — the
  // safe default that exists now (guessing the Next layout into a Worker
  // host was the field failure; the non-interactive guard still demands an
  // explicit --framework so agents never inherit a guess silently).
  const detected = options.framework ?? await detectFramework(root);
  const framework: "next" | "express" | "custom" = detected === "unknown" ? "custom" : detected;
  const changes: PlannedChange[] = [];
  const edits: ManualEdit[] = [];
  let authAdvice: string | null = null;
  let authWired: AuthMatch | null = null;
  let compositionPath: string | null = null;
  let registryPath: string | null = null;
  let withRegistry = false;
  let layout: LayoutWiring = { kind: "manual" };

  if (framework === "custom") {
    layout = { kind: "custom" };
    const wiring = await detectVendoWiring(root);
    if (!wiring.server || !wiring.client) {
      const typescript = await exists(join(root, "tsconfig.json"));
      const server = join(root, "vendo", typescript ? "server.ts" : "server.mjs");
      const registryFile = join(root, "vendo", typescript ? "registry.tsx" : "registry.mjs");
      const registryBefore = await readOptional(registryFile);
      const serverBefore = await readOptional(server);
      // Same ownership rules as the Express branch: init composes only when
      // it CREATES the composition, and the registry regenerates only for a
      // consumer that uses it.
      const scaffolding = serverBefore === null && !wiring.server;
      const registryPlanned = registryBefore === null
        && (scaffolding || serverBefore?.includes("./registry") === true);
      if (registryPlanned) {
        const path = relative(root, registryFile);
        const registryAfter = registrySource(typescript ? "tsx" : "mjs");
        changes.push({ absolute: registryFile, path, before: null, after: registryAfter, diff: diff(path, null, registryAfter) });
        registryPath = path;
      }
      if (scaffolding) {
        const path = relative(root, server);
        const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
        const serverAfter = customServerSource(typescript, auth.wired);
        changes.push({ absolute: server, path, before: null, after: serverAfter, diff: diff(path, null, serverAfter) });
        authAdvice = auth.advice;
        authWired = auth.wired;
        compositionPath = path;
      }
      withRegistry = registryBefore !== null || registryPlanned;
    }
  } else if (framework === "express") {
    layout = { kind: "express" };
    const wiring = await detectVendoWiring(root);
    if (!wiring.server || !wiring.client) {
      const typescript = await exists(join(root, "tsconfig.json"));
      const server = join(root, "vendo", typescript ? "server.ts" : "server.mjs");
      const registryFile = join(root, "vendo", typescript ? "registry.tsx" : "registry.mjs");
      const registryBefore = await readOptional(registryFile);
      const serverBefore = await readOptional(server);
      // Init owns the composition only when it CREATES it: no generated
      // server module yet AND no hand-wired createVendo anywhere else. A host
      // that composed at its own path but hasn't pasted <VendoRoot> yet gets
      // neither a duplicate server module nor an orphaned registry — the
      // Express analog of the Next branch's routeBefore === null guard.
      const scaffolding = serverBefore === null && !wiring.server;
      // The registry regenerates only for a composition that uses it: the one
      // being created now, or a previously generated server module whose
      // ./registry import would otherwise dangle. Never clobbered.
      const registryPlanned = registryBefore === null
        && (scaffolding || serverBefore?.includes("./registry") === true);
      if (registryPlanned) {
        const path = relative(root, registryFile);
        const registryAfter = registrySource(typescript ? "tsx" : "mjs");
        changes.push({ absolute: registryFile, path, before: null, after: registryAfter, diff: diff(path, null, registryAfter) });
        registryPath = path;
      }
      if (scaffolding) {
        const path = relative(root, server);
        // Detect + confirm happens only here — fresh composition creation —
        // so a re-run before the manual <VendoRoot> paste neither asks nor
        // re-fires the advisory after "Already wired".
        const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
        const serverAfter = expressServerSource(typescript, auth.wired);
        changes.push({ absolute: server, path, before: null, after: serverAfter, diff: diff(path, null, serverAfter) });
        authAdvice = auth.advice;
        authWired = auth.wired;
        compositionPath = path;
      }
      withRegistry = registryBefore !== null || registryPlanned;
    }
  } else {
    const app = await appDirectory(root);
    const route = join(app, "api", "vendo", "[...vendo]", "route.ts");
    const actionsModule = join(app, "api", "vendo", "[...vendo]", "vendo-actions.ts");
    const routeBefore = await readOptional(route);
    const actionsBefore = await readOptional(actionsModule);
    const registrations = await requiredServerActions(root);
    // The shared registry mirrors the app dir (src/app → src/vendo): generated
    // only while absent and only when the route uses it — a fresh scaffold, or
    // a route that already imports vendo/registry. A hand-wired route that
    // ignores the registry never grows an orphan file.
    const registryFile = join(dirname(app), "vendo", "registry.tsx");
    const registryBefore = await readOptional(registryFile);
    const registryPlanned = registryBefore === null
      && (routeBefore === null || routeBefore.includes("vendo/registry"));
    if (registryPlanned) {
      const path = relative(root, registryFile);
      const registryAfter = registrySource("tsx");
      changes.push({ absolute: registryFile, path, before: null, after: registryAfter, diff: diff(path, null, registryAfter) });
      registryPath = path;
    }
    withRegistry = registryBefore !== null || registryPlanned;
    // The registration map is generated once, when the host's first
    // "use server" action appears. After that it is the developer's file and is
    // never rewritten — so an existing one is compared by the KEYS it registers,
    // not byte-for-byte. Byte-comparing would demand a paste for their own
    // formatting, their own extra entries, and even a reworded comment in a
    // Vendo release, forever, on a surface that never moved.
    // …and the map exists only for a route that will CONSUME it: the one being
    // created now, one that already imports ./vendo-actions, or one init is
    // about to hand the import paste to. A route composing its own map never
    // grows an orphan — the same rule the registry above follows, and the same
    // shape doctor stays silent about.
    const mapConsumed = routeBefore === null
      || importsGeneratedMap(routeBefore)
      || serverActionsWiring(routeBefore) === "unwired";
    if (registrations.length > 0 && mapConsumed) {
      const path = relative(root, actionsModule);
      if (actionsBefore === null) {
        const actionsAfter = serverActionsModuleSource(root, dirname(actionsModule), registrations);
        changes.push({ absolute: actionsModule, path, before: null, after: actionsAfter, diff: diff(path, null, actionsAfter) });
      } else {
        const missing = missingRegistrations(actionsBefore, registrations);
        if (missing.length > 0) {
          edits.push({
            file: path,
            lines: missingRegistrationLines(root, dirname(actionsModule), actionsBefore, missing),
            why: `${missing.length} action${missing.length === 1 ? "" : "s"} the host exposes ${missing.length === 1 ? "is" : "are"} not registered here — ${missing.length === 1 ? "it fails" : "each one fails"} closed at execution time (no work performed). The rest of the file is yours; nothing else needs to change.`,
          });
        }
      }
    }
    if (routeBefore === null) {
      const path = relative(root, route);
      // Detect + confirm happens only on fresh composition creation.
      const auth = await resolveScaffoldAuth(root, path, options.auth, confirmAuth, selectAuth);
      const registrySpecifier = relative(dirname(route), join(dirname(app), "vendo", "registry")).split(sep).join("/");
      const routeAfter = routeSource({ serverActions: registrations.length > 0, auth: auth.wired, registrySpecifier });
      changes.push({ absolute: route, path, before: routeBefore, after: routeAfter, diff: diff(path, routeBefore, routeAfter) });
      authAdvice = auth.advice;
      authWired = auth.wired;
      compositionPath = path;
    } else if (registrations.length > 0) {
      // The route already exists but server actions appeared since it was
      // generated: name the wiring the existing createVendo is missing, so
      // server-action execution stops failing closed (ENG-248).
      const edit = routeServerActionsEdit(routeBefore, relative(root, route));
      if (edit !== null) edits.push(edit);
    }

    // Visible surface (0.4.1 E2E cert B3): the client mount wrapper next to
    // the registry — the "use client" boundary that owns the registry + theme
    // imports (passing the registry from the Server Component layout into the
    // client provider fails RSC serialization) and mounts <VendoOverlay />.
    // A NEW Vendo-owned file, so init writes it; mounting it in the host's own
    // layout is the developer's paste (init never writes user-authored files),
    // printed by mountStep and gated by doctor's E-WIRE-004.
    const wrapperFile = join(dirname(app), "vendo", "vendo-root.tsx");
    const wrapperBefore = await readOptional(wrapperFile);
    // The generated wrapper doesn't count as a host mount: its overlay is
    // only real once a layout mounts the wrapper itself.
    const mounts = await detectVendoWiring(root, { exclude: [wrapperFile] });
    if (mounts.client || mounts.surface) {
      // A mounted <VendoRoot> next to an existing wrapper IS the surface —
      // the wrapper renders <VendoOverlay />.
      layout = mounts.surface || wrapperBefore !== null
        ? { kind: "already" }
        // A pages-only host mounted <VendoRoot> in pages/_app.tsx, not in an
        // app/layout.tsx it doesn't have — name the file it really wraps in.
        : { kind: "overlay-missing", layoutPath: relative(root, (await clientRoot(root)).file) };
    } else if (withRegistry && wrapperBefore === null) {
      // The wrapper consumes ./registry, so it exists only alongside one —
      // a hand-wired host that ignores the registry keeps the direct paste.
      const path = relative(root, wrapperFile);
      const themeSpecifier = await themeImportSpecifier(root, dirname(wrapperFile));
      const wrapperAfter = vendoRootWrapperSource({ themeSpecifier });
      changes.push({ absolute: wrapperFile, path, before: null, after: wrapperAfter, diff: diff(path, null, wrapperAfter) });
    }
  }
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
  const mount = await mountStep(root, layout, withRegistry);
  const manualSteps = [
    ...await manualWiringLines(root, layout, withRegistry),
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
    registryPath,
    layout,
    plan: {
      framework,
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

/** The value of one NAME=value line in .env.local (the cloud step's upsert
    target) — the same-run pickup reads the freshly minted key back from disk.
    One parser for the whole CLI: shared.ts's envLocalValueSync (telemetry's
    cloud-key read uses the same one, so the two can never disagree). */
async function envLocalValue(root: string, name: string): Promise<string | null> {
  return envLocalValueSync(root, name);
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
  // An undetectable framework has NO safe default: a non-interactive run
  // (agents) errors with the exact flag instead of guessing the Next layout
  // into an unknown host. An interactive run keeps today's fall-through to the
  // custom scaffold — silently wrong when the host is a workspace package one
  // level down, so name the candidates instead of guessing for them.
  if (options.framework === undefined && await detectFramework(root) === "unknown") {
    if (options.yes === true || !interactive) {
      output.error(
        "Framework not detected (no next or express dependency in package.json) and this run cannot ask. " +
        "Pass --framework. Examples: vendo init --yes --framework next · --framework custom (any Web-standard runtime: Cloudflare Workers, Bun, Hono, ...)",
      );
      return 1;
    }
    const candidates = await workspaceHostCandidates(root);
    if (candidates.length > 0) {
      output.error(
        `warning: no next or express dependency in this directory, but ${candidates.join(", ")} ` +
        `${candidates.length === 1 ? "looks" : "look"} like the host — did you mean ${candidates[0]}? ` +
        `Re-run there (vendo init ${pastePath(join(root, candidates[0]!))}) or pass --framework to scaffold this directory anyway.`,
      );
    }
  }
  // (No stdin-TTY guard on these defaults, unlike the star ask's: an unshown
  // auth confirm resolving its default just wires the detected preset — the
  // very accept the non-interactive path performs silently anyway.)
  const confirmAuth = options.yes === true || !interactive
    ? undefined
    : (options.confirmAuth ?? (pretty === null ? askYesNo : pretty.confirm));
  const selectAuth = options.yes === true || !interactive
    ? undefined
    : (options.selectAuth ?? (pretty === null ? plainSelect : pretty.select));
  const detectStarted = Date.now();
  const { plan, changes, edits, manualSteps, mount, authAdvice, authWired, compositionPath, registryPath, layout } = await buildPlan(options, confirmAuth, selectAuth);
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
      await warnEnvLocalNotIgnored(root, output);
    }
    // Key first (product order fix): the model-credential story — env keys,
    // else the Vendo Cloud offer — runs BEFORE the AI-assisted passes, so a
    // starter key minted here powers the SAME run's theme model pass and AI
    // polish instead of those passes reporting "no model" while the offer
    // waits below them. --yes / non-interactive semantics are unchanged.
    // Dev keys may live in .env.local rather than this process's env — a
    // PRIOR run's minted starter key, or hand-added provider keys. Merge
    // them into the env every credential consumer reads (credential ladder,
    // cloud step, theme model pass, AI polish); an explicit env value
    // always wins over .env.local.
    let effectiveEnv = env;
    for (const name of [...ENV_KEY_VARS.map((entry) => entry.envVar), "VENDO_API_KEY"]) {
      if ((env[name] ?? "").trim() !== "") continue;
      const stored = await envLocalValue(root, name);
      if (stored !== null) effectiveEnv = { ...effectiveEnv, [name]: stored };
    }
    let credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
    if (credential.rung === "env-key") {
      output.log(`Model: ${describeDevCredential(credential)} — production uses this same key server-side.`);
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
      ...(pretty === null ? {} : { confirm: pretty.confirm }),
      ...(options.cloud ?? {}),
    });
    // Same-run pickup: a starter key minted just now lands in .env.local —
    // merge it the same way so THIS run's passes already benefit.
    if (cloud.wroteEnvLocal) {
      const minted = await envLocalValue(root, "VENDO_API_KEY");
      if (minted !== null) {
        effectiveEnv = { ...effectiveEnv, VENDO_API_KEY: minted };
        credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
      }
    }
    // A key that landed in .env.local THIS run (--cloud-key upsert or the
    // login ceremony) must activate the telemetry cloud lane for the rest of
    // this run's events too — rebuild the client so it re-reads .env.local.
    // A pre-existing key was already picked up at the first construction.
    if (options.cloudKey !== undefined || cloud.wroteEnvLocal) {
      telemetry = telemetryFor(options, output, root);
    }

    // Wire — apply the bounded change set and list it. No gates, no prompts.
    // (Timed for the cloud lane's wiringMs; the static scan below adds on.)
    const wiringStarted = Date.now();
    for (const change of changes) {
      await writeText(change.absolute, change.after);
    }

    // Scan — .vendo artifacts + static extraction (the hints layer for the AI
    // extraction; interim tools.json source until it lands).
    await ensureVendoEnvExample(root);
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeIfMissing(
      join(root, ".vendo", "overrides.json"),
      `${JSON.stringify({
        format: "vendo/overrides@3",
        tools: {},
        remix: { ignoreSlots: [] },
      }, null, 2)}\n`,
      options.force === true,
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
      options.force === true,
    );
    await writeIfMissing(
      join(root, ".vendo", "brief.md"),
      BRIEF_PLACEHOLDER,
      options.force === true,
    );
    // Theme (Task 2/4 re-derive): the exact-only allowlist pass runs and
    // writes theme.json right away — never overwriting an existing one (it
    // is the editable source of truth) unless --force. Whatever brand slots
    // the allowlist left unfilled ride the consent-gated AI-polish pass
    // below; the merge, --theme answers, the one-glance palette print, and
    // the uncertain-slot review all happen AFTER that pass returns, further
    // down this function — a pre-existing theme.json is never touched.
    const themePath = join(root, ".vendo", "theme.json");
    const themeCreatedThisRun = options.force === true || !(await exists(themePath));
    let wiringMs = Date.now() - wiringStarted;
    let themeMs: number | undefined;
    let themeSummary: ThemeSummary | null = null;
    if (themeCreatedThisRun) {
      pretty?.spin("Capturing your theme");
      const themeStarted = Date.now();
      themeSummary = await extractThemeSlots(root);
      themeMs = Date.now() - themeStarted;
      pretty?.stopSpin();
      await writeText(themePath, `${JSON.stringify(toVendoTheme(themeSummary.slots), null, 2)}\n`);
      // The merge base for every later `vendo sync` theme re-scan: what the
      // DETERMINISTIC pass read, before any model fill or --theme answer —
      // those are decisions, and sync must pin them (theme/provenance.ts).
      await writeBase(join(root, ".vendo"), baseFrom(themeSummary));
    }
    await writeIfMissing(join(root, ".vendo", "data", ".gitignore"), "*\n!.gitignore\n", options.force === true);

    pretty?.spin("Learning your API surface");
    const scanStarted = Date.now();
    const report = await vendoSync({ root, out: join(root, ".vendo") });
    wiringMs += Date.now() - scanStarted;
    pretty?.stopSpin();
    for (const warning of report.warnings) output.error(`warning: ${warning}`);

    let toolCount = 0;
    let routeCount = 0;
    try {
      const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8")) as {
        tools?: Array<{ binding?: { kind?: string } }>;
      };
      toolCount = tools.tools?.length ?? 0;
      routeCount = tools.tools?.filter((tool) => tool.binding?.kind === "route").length ?? 0;
    } catch {
      // Sync already reported any extraction warning; telemetry gets a count only.
    }

    // Summary — what changed, what was learned.
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
    output.log(`Learned: ${toolCount} tools · theme captured → .vendo/ (tools.json, theme.json, brief.md)`);

    // The judgment pass, then the brief and theme stages: a coding agent grades
    // the extracted catalog with a verbatim source quote behind every proposal,
    // an independent skeptic checks each one, and loosenings wait for a human
    // (reviewed inline in an interactive run). Consent-gated; skipped silently
    // when non-interactive or credential-less. Judgments land in
    // `.vendo/judgments.json`, so `overrides.json` keeps meaning only "what a
    // person decided" and a re-sync can never clobber either.
    const engineStarted = Date.now();
    const polish = await runInitJudgment({
      root,
      output,
      env: effectiveEnv,
      yes: options.yes === true,
      // --ai IS the consent (no prompt, non-interactive runs stop skipping);
      // --no-ai is the refusal. No flag = ask, every interactive run.
      ...(options.ai === undefined ? {} : { ai: options.ai }),
      ...(options.force === true ? { force: true } : {}),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(pretty === null ? {} : { confirm: pretty.confirm, choose: pretty.select }),
      ...(themeCreatedThisRun && themeSummary !== null ? {
        theme: {
          needed: themeSummary.needed,
          alreadyExact: Object.fromEntries(
            Object.entries(themeSummary.matched)
              .filter(([, provenance]) => provenance.startsWith("--"))
              .map(([slot]) => [slot, String(themeSummary!.slots[slot as keyof ThemeSlotValues])]),
          ),
          evidencePaths: themeSummary.evidencePaths,
        },
      } : {}),
      ...(options.extract ?? {}),
    });
    const engineMs = Date.now() - engineStarted;

    // Theme finalization (Task 4): merge whatever the AI pass filled — if
    // consent was declined or unavailable, `polish.theme` is simply absent
    // and the exact-only summary stands — then --theme answers (a human
    // "(you)" wins over a model value), the one-glance palette print, and
    // finally the uncertain-slot review. Skipped entirely when theme.json
    // pre-existed this run (nothing above ran either).
    if (themeCreatedThisRun && themeSummary !== null) {
      const summary = polish.theme === undefined ? themeSummary : applyThemeDraft(themeSummary, polish.theme);
      // --theme answers land first; the review prompt then covers only the
      // uncertain slots the flags left unanswered (non-interactive runs keep
      // the extracted/merged values for those, exactly as before).
      const answers: Record<string, string> = { ...(options.themeAnswers ?? {}) };
      const unanswered = summary.uncertain.filter((entry) => !Object.hasOwn(answers, entry.slot));
      if (unanswered.length > 0 && options.yes !== true) {
        const reviewed = await (options.themeReview ?? defaultThemeReview)(
          unanswered.length === summary.uncertain.length ? summary : { ...summary, uncertain: unanswered },
        );
        for (const [slot, raw] of Object.entries(reviewed)) {
          if (!Object.hasOwn(answers, slot)) answers[slot] = raw;
        }
      }
      if (Object.keys(answers).length > 0) {
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
      await writeText(themePath, `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
      printThemeSummary(summary, output);
    }

    // Judgment state, one line: a pass that ran already narrated itself (it
    // owns the judged/queued/rejected counts); otherwise say so honestly.
    if (!polish.ran) {
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
      engine: polish.engine ?? "none",
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
      ...(themeMs === undefined ? {} : { themeMs }),
      wiringMs,
      ...(await cloudProjectProps(root)),
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

    // Done — the pastes init cannot take (it only ever CREATES files in your
    // source tree), then their own dev server. They get their own framed block
    // because skipping them is the whole failure mode: a green install nobody
    // can see, or server-action tools that silently fail closed.
    const handSteps = [...(mount === null ? [] : [mount]), ...edits];
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
      output.log("  Then confirm it landed: npx vendo doctor");
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

    // Agent tail (agent-install-dx): the --yes-or-non-TTY path is agent-driven
    // — the run's FINAL block is the repo-specific pointers an agent parses.
    // Interactive human runs keep the clack-style output untouched; --agent
    // never reaches here (its read-only JSON plan returned above).
    if (options.yes === true || !interactive) {
      output.log("\nAgent tail:");
      const tail = await agentTailLines({ root, framework: plan.framework, registryPath, compositionPath, authWired, layout, edits, cloudKeyMissing: credential.rung === "none" });
      for (const line of tail) output.log(`  ${line}`);
    } else {
      // Star ask (agent-install-dx §CLI-5): the interactive success screen
      // ends with ONE consent question — never shown non-interactively (the
      // playbook owns the agent-path ask; deterministic runs stay that way),
      // and never fatal: nothing in this step can change init's exit code.
      // Yes stars via gh; any failure degrades to the repo URL, one line.
      // No does nothing — no guilt text.
      try {
        // Consent guard: an unshown prompt is NEVER a yes. On a non-TTY
        // stdin (programmatic `interactive: true`, `init < file`) both real
        // confirms would resolve the default — pretty.confirm returns it,
        // askYesNo would block — and starring is an account action, so the
        // answer without a real keyboard is false, regardless of path.
        const confirmStar = options.confirmStar
          ?? (async (question: string, defaultYes: boolean) =>
            stdin.isTTY === true
              ? (pretty === null ? askYesNo : pretty.confirm)(question, defaultYes)
              : false);
        if (await confirmStar(`Star ${STAR_REPO} to support the project?`, true)) {
          const starred = await starViaGh(
            options.spawnStar ?? ((command, args) => spawn(command, args, { stdio: "ignore" })),
          );
          if (!starred) output.log(`Star it anytime: ${STAR_LINK}`);
          // Star attribution: `starred` is an exact star-from-the-CLI signal
          // (closed outcome enum; counts-and-enums promise holds).
          await telemetry.track("star_prompt", { outcome: starred ? "starred" : "star-failed" });
        } else {
          await telemetry.track("star_prompt", { outcome: "declined" });
        }
      } catch {
        // The ask is best-effort by design; init already succeeded.
      }
    }
    // The run's LAST word is the outstanding paste, on both paths (self-serve
    // audit F5: interactive installs used to end on the star ask with the one
    // step that matters scrolled off-screen). The frame itself stays up-screen
    // — the agent tail's "the lines above" pointers depend on that order — so
    // the closer is a one-line echo of it, not a second copy.
    if (handSteps.length > 0) {
      output.log(handSteps.length === 1
        ? `\n→ Don't forget the paste in ${handSteps[0]!.file} (frame above)`
        : `\n→ Don't forget the ${handSteps.length} pastes above (frame above)`);
    }
    pretty?.done(Date.now() - started, true);
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
