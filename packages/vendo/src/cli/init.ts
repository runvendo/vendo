import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  mergeOverrides,
  vendoSync,
  type ExtractedTool,
  type OverridesFile,
} from "@vendoai/actions";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { VendoTheme } from "@vendoai/core";
import { scrubErrorDetail, type Telemetry } from "@vendoai/telemetry";
import { detectDepVersions, installedAiVersion } from "./dep-versions.js";
import { AUTH_MD_URL, runCloudStep, upsertEnvLocal, type CloudStepOptions } from "./cloud-init.js";
import { APPLY_COMMAND, composeDelegatedInstructions, EXTRACTION_DRAFT_JSON_SCHEMA } from "./extract/delegate.js";
import { askYesNo, runAiExtraction, type AiExtractionOptions } from "./extract/extraction.js";
import { BRIEF_TEMPLATE, type StaticTool } from "./extract/stages.js";
import { ENV_KEY_VARS, resolveDevCredential, describeDevCredential, type DevCredential } from "../dev-creds/resolve.js";
import { detectFramework, detectVendoWiring, type HostFramework } from "./framework.js";
import { resolveScaffoldAuth, type AuthMatch, type AuthPresetName, type ConfirmAuth, type SelectAuth } from "./init-auth.js";
import {
  expressServerSource,
  registrySource,
  routeSource,
  serverActionsModuleSource,
  VENDO_ENV_EXAMPLE,
  wiringServerActions,
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
import {
  cloudProjectProps,
  consoleOutput,
  envLocalValueSync,
  errorClass,
  exists,
  readOptional,
  toolingTelemetry,
  type Output,
  writeText,
} from "./shared.js";

/**
 * `vendo init` (install-dx v1, re-derived 2026-07-18): one command, zero
 * questions on the happy path, no ceremony.
 *
 *   scan → wire (the two-file surface — empty vendo/registry.tsx + the
 *   catch-all handler wired to it; a detected auth preset gets one
 *   consent-style confirm in interactive runs, --yes/non-interactive accept
 *   it silently — plus package.json hooks; never edits user-authored code)
 *   → key (env stated, else the cloud starter offer) → done summary (files
 *   changed, the VendoRoot line to paste, next steps).
 *
 * Removed by design: the interview, per-diff y/N approvals, the layout
 * codemod, the lib/ai.ts scaffold (createVendo's `model` is optional now),
 * remix offers, the encryption-key step, the refine offer, and the finale
 * ceremony (doctor owns verification and the live turn).
 */

const DEFAULT_RADIUS = { small: "4px", large: "12px" } as const;

const BRIEF_PLACEHOLDER = `${BRIEF_TEMPLATE}\n`;

function toVendoTheme(slots: ThemeSlotValues): VendoTheme {
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

export interface InitPlan {
  framework: HostFramework;
  root: string;
  writes: string[];
  codeChanges: Array<{ path: string; diff: string }>;
  /** The one line init never writes itself: the user pastes it. */
  manualSteps: string[];
  /** --agent only: deterministic extraction results, so an agent can act on
      real tool names instead of re-deriving them. */
  extraction?: { tools: ExtractedTool[]; warnings: string[] };
  riskRecommendations?: RiskRecommendation[];
  /** --agent only: the delegated AI-polish contract. An external coding agent
      reads the codebase against `instructions`, writes a draft matching
      `draftSchema`, and lands it with `apply` — the SAME deterministic guards
      as init's built-in pass decide what applies. */
  aiPolish?: { instructions: string; draftSchema: Record<string, unknown>; apply: string };
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
  framework?: Exclude<HostFramework, "unknown">;
  /** --cloud-key: answer the cloud-login offer with an existing key — landed
      in .env.local exactly where the mint would put it. */
  cloudKey?: string;
  /** --byo: answer the cloud-login offer with "no — bring my own key". */
  byo?: boolean;
  /** --ai-polish: consent to the AI extraction pass without the prompt. */
  aiPolish?: boolean;
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
  /** Test seam (ENG-339): cloud-in-init step overrides. */
  cloud?: Partial<Omit<CloudStepOptions, "root" | "output" | "yes" | "credential">>;
  /** Test seam: AI extraction step overrides (harnesses, consent). */
  extract?: Partial<Omit<AiExtractionOptions, "root" | "output" | "yes" | "env">>;
  /** Test seam: the detect+confirm auth question, asked only in interactive
      runs when exactly one auth family is detected and init is creating the
      composition. Mirrors the AI-polish consent's confirm shape. */
  confirmAuth?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Test seam: the auth picker shown when the confirm is declined or when
      several families are detected. Receives the choice list (value/label/
      hint) and resolves the chosen value. */
  selectAuth?: (question: string, options: SelectOption[]) => Promise<string>;
  /** Test seam: interactivity override for the auth confirm (default: TTY),
      mirroring runAiExtraction's `interactive`. */
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
async function detectRouter(root: string, framework: HostFramework): Promise<"app" | "pages" | "none"> {
  if (framework === "next") {
    if (await exists(join(root, "src", "app")) || await exists(join(root, "app"))) return "app";
    if (await exists(join(root, "src", "pages")) || await exists(join(root, "pages"))) return "pages";
  }
  return "none";
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
 * Wire the server-action registration map into an EXISTING generated route
 * (ENG-248 idempotency fix): a host that adds `"use server"` actions AFTER the
 * initial init gets vendo-actions.ts generated, but its route.ts still calls
 * `createVendo` without `serverActions` — so every server-action call fails
 * closed at runtime. Best-effort: rewrites only the recognized
 * `createVendo({ ... })` shape; returns null when already wired or the shape is
 * unrecognized (never corrupts a hand-customized route). Idempotent: a route
 * that already imports and passes serverActions yields null.
 */
function wireRouteServerActions(source: string): string | null {
  const importsMap = /from\s+["']\.\/vendo-actions["']/.test(source);
  const call = source.match(/createVendo\(\s*\{/);
  if (!call) return null; // unrecognized composition — leave it untouched
  const callIndex = source.indexOf(call[0]);
  const passesActions = /(^|[\s{,])serverActions\b/.test(source.slice(callIndex));
  // Already wired, or hand-customized: a route that passes serverActions
  // sourced from anywhere other than ./vendo-actions (a local map, an aliased
  // import) would get a conflicting duplicate binding from our import — leave
  // it untouched either way.
  if (passesActions) return null;

  let next = source;
  if (!importsMap) {
    const importLine = `import { serverActions } from "./vendo-actions";`;
    const serverImport = next.match(/^.*from\s+["']@vendoai\/vendo\/server["'];?[^\n]*$/m);
    if (serverImport) {
      const at = next.indexOf(serverImport[0]) + serverImport[0].length;
      next = `${next.slice(0, at)}\n${importLine}${next.slice(at)}`;
    } else {
      next = `${importLine}\n${next}`;
    }
  }
  next = next.replace(/createVendo\(\s*\{/, (match) => `${match}\n  serverActions,`);
  return next === source ? null : next;
}

function packageWithSyncHooks(raw: string): string | null {
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const priorScripts = manifest["scripts"];
  const scripts = typeof priorScripts === "object" && priorScripts !== null && !Array.isArray(priorScripts)
    ? priorScripts as Record<string, unknown>
    : {};
  let changed = false;
  const hook = (name: "predev" | "prebuild", command: string): void => {
    const prior = scripts[name];
    if (typeof prior !== "string") {
      scripts[name] = command;
      changed = true;
    } else if (!prior.includes(command)) {
      scripts[name] = `${command} && ${prior}`;
      changed = true;
    }
  };
  hook("predev", "vendo sync");
  hook("prebuild", "vendo sync --strict");
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

/** Project extraction results onto the small static-facts shape the
    delegation instructions carry (route bindings surface method+path). */
function planStaticTools(tools: ExtractedTool[]): StaticTool[] {
  return tools.map((tool) => {
    const binding = tool.binding as { method?: unknown; path?: unknown };
    return {
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      ...(tool.disabled === true ? { disabled: true } : {}),
      ...(typeof binding.method === "string" ? { method: binding.method } : {}),
      ...(typeof binding.path === "string" ? { path: binding.path } : {}),
    };
  });
}

/** 04-actions §1 risk ladder projected as advice: destructive asks first,
    writes get reviewed, reads auto-run (no entry). */
function riskRecommendations(tools: ExtractedTool[]): RiskRecommendation[] {
  return tools.flatMap((tool) => {
    if (tool.disabled === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "extracted disabled (unclassifiable); enable it deliberately in .vendo/overrides.json after review" }];
    }
    if (tool.critical === true) {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "already marked critical in .vendo/overrides.json; policy asks before running it" }];
    }
    if (tool.risk === "destructive") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "irreversible; mark it critical in .vendo/overrides.json so policy asks first" }];
    }
    if (tool.risk === "write") {
      return [{ tool: tool.name, risk: tool.risk, recommendation: "writes host data; review it and mark critical in .vendo/overrides.json when irreversible" }];
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

/** The one line init never writes: the user pastes the VendoRoot wrap. When
    the shared registry exists (scaffolded or host-authored) the wrap carries
    `components={registry}` — the client half of the one-file/two-consumers
    pattern; it stays ONE pasted line plus its imports. */
async function vendoRootPasteLines(root: string, framework: HostFramework, withRegistry: boolean): Promise<string[]> {
  if (framework === "express") {
    const wrap = withRegistry
      ? `<VendoRoot components={registry} theme={theme}>…</VendoRoot>`
      : `<VendoRoot theme={theme}>…</VendoRoot>`;
    return [
      `app.use("/api/vendo", mountVendo());   // in your server`,
      `${wrap}  // around your client root (see vendo/server for the imports)`,
    ];
  }
  const app = await appDirectory(root);
  const specifier = await themeImportSpecifier(root, app);
  const layout = relative(root, join(app, "layout.tsx"));
  const registrySpecifier = relative(app, join(dirname(app), "vendo", "registry")).split(sep).join("/");
  const importLines = [
    `import { VendoRoot } from "@vendoai/vendo/react";`,
    ...(withRegistry ? [`import { registry } from ${JSON.stringify(registrySpecifier)};`] : []),
    ...(specifier === null
      ? []
      : [
          `import theme from ${JSON.stringify(specifier)};`,
          `import type { VendoTheme } from "@vendoai/vendo";`,
        ]),
  ];
  const props = [
    ...(withRegistry ? ["components={registry}"] : []),
    ...(specifier === null ? [] : ["theme={theme as VendoTheme}"]),
  ];
  const wrap = `<VendoRoot${props.length === 0 ? "" : ` ${props.join(" ")}`}>{children}</VendoRoot>`;
  return [`In ${layout}:`, ...importLines.map((line) => `  ${line}`), `  … then wrap: ${wrap}`];
}

/** The repo-specific agent tail (agent-install-dx): a non-interactive
    scaffold run is agent-driven, so the run ends with plain deterministic
    pointers — the wired auth preset and what is still stubbed about it, the
    exact files left to hand-edit (derived from what THIS run wrote, never
    canned prose), and the one doctor command that gates "done". A pointer to
    work, not documentation: the playbook carries the teaching. */
async function agentTailLines(args: {
  root: string;
  framework: HostFramework;
  registryPath: string | null;
  compositionPath: string | null;
  authWired: AuthMatch | null;
  /** No model credential resolved this run — the tail points the agent at
      the auth.md key flow (Agent Install DX, Layer 2). */
  cloudKeyMissing: boolean;
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
    lines.push("edit your server and client entries — paste the mountVendo() and <VendoRoot> lines above");
  } else {
    const layout = relative(args.root, join(await appDirectory(args.root), "layout.tsx"));
    lines.push(`edit ${layout} — wrap the app in the <VendoRoot> lines above`);
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

async function buildPlan(options: InitOptions, confirmAuth?: ConfirmAuth, selectAuth?: SelectAuth): Promise<{
  plan: InitPlan;
  changes: PlannedChange[];
  manualSteps: string[];
  authAdvice: string | null;
  /** What the fresh composition wired (agent-tail fact); null when no
      composition was created this run OR it stayed anonymous. */
  authWired: AuthMatch | null;
  /** Relative path of the composition created THIS run; null otherwise. */
  compositionPath: string | null;
  /** Relative path of the registry generated THIS run; null otherwise. */
  registryPath: string | null;
}> {
  const root = resolve(options.targetDir);
  const framework = options.framework ?? await detectFramework(root);
  const changes: PlannedChange[] = [];
  let authAdvice: string | null = null;
  let authWired: AuthMatch | null = null;
  let compositionPath: string | null = null;
  let registryPath: string | null = null;
  let withRegistry = false;

  if (framework === "express") {
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
    const registrations = await wiringServerActions(root);
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
    // The registration map regenerates whenever the detected "use server"
    // surface changes; an existing map is kept compiling (emptied, never
    // deleted) when the last action disappears.
    if (registrations.length > 0 || actionsBefore !== null) {
      const actionsAfter = serverActionsModuleSource(root, dirname(actionsModule), registrations);
      if (actionsAfter !== actionsBefore) {
        const path = relative(root, actionsModule);
        changes.push({ absolute: actionsModule, path, before: actionsBefore, after: actionsAfter, diff: diff(path, actionsBefore, actionsAfter) });
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
      // generated: wire the registration map into the existing createVendo so
      // server-action execution doesn't fail closed (ENG-248 idempotency fix).
      const wiredRoute = wireRouteServerActions(routeBefore);
      if (wiredRoute !== null) {
        const path = relative(root, route);
        changes.push({ absolute: route, path, before: routeBefore, after: wiredRoute, diff: diff(path, routeBefore, wiredRoute) });
      }
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
    ".vendo/data/.gitignore",
  ];
  const manualSteps = await vendoRootPasteLines(root, framework, withRegistry);
  return {
    changes,
    manualSteps,
    authAdvice,
    authWired,
    compositionPath,
    registryPath,
    plan: {
      framework,
      root,
      writes,
      codeChanges: changes.map(({ path, diff: rendered }) => ({ path, diff: rendered })),
      manualSteps,
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
    let appName = "app";
    try {
      appName = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
    } catch {
      // package.json is optional context
    }
    output.log(JSON.stringify({
      ...plan,
      extraction,
      riskRecommendations: riskRecommendations(extraction.tools),
      // The delegation contract: the agent reading this plan can do the AI
      // polish itself and land it through `vendo extract --apply` — the same
      // deterministic guards as init's built-in pass.
      aiPolish: {
        instructions: composeDelegatedInstructions(planStaticTools(extraction.tools), appName),
        draftSchema: EXTRACTION_DRAFT_JSON_SCHEMA,
        apply: APPLY_COMMAND,
      },
    } satisfies InitPlan, null, 2));
    return 0;
  }

  // Detect + confirm (interactive runs only): --yes and non-interactive runs
  // accept the detected default silently — the same interactivity posture as
  // the AI-polish consent.
  const interactive = options.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  // An undetectable framework has NO safe default: a non-interactive run
  // (agents) errors with the exact flag instead of guessing the Next layout
  // into an unknown host. Interactive runs keep today's fall-through.
  if (options.framework === undefined && (options.yes === true || !interactive)
    && await detectFramework(root) === "unknown") {
    output.error(
      "Framework not detected (no next or express dependency in package.json) and this run cannot ask. " +
      "Pass --framework. Example: vendo init --yes --framework next",
    );
    return 1;
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
  const { plan, changes, manualSteps, authAdvice, authWired, compositionPath, registryPath } = await buildPlan(options, confirmAuth, selectAuth);
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
        format: "vendo/overrides@1",
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

    // AI extraction (install-dx, staged): a coding agent surveys the repo,
    // drafts each surface in a focused pass, cross-checks the combined draft,
    // and drafts the brief — all into the override channel; deterministic
    // guards decide what applies. Consent-gated; skipped silently when
    // non-interactive or credential-less. A successful pass re-syncs so
    // tools.json reflects the polish immediately.
    const engineStarted = Date.now();
    const polish = await runAiExtraction({
      root,
      output,
      env: effectiveEnv,
      yes: options.yes === true,
      // --ai-polish IS the consent: no prompt, and non-interactive runs
      // stop skipping.
      ...(options.aiPolish === true ? { consent: true } : {}),
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

    if (polish.ran) {
      const resynced = await vendoSync({ root, out: join(root, ".vendo") });
      for (const warning of resynced.warnings) output.error(`warning: ${warning}`);
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

    // Done — the one paste that is the user's, then their own dev server.
    output.log("\nLast steps are yours:");
    for (const line of manualSteps) output.log(`  ${line}`);
    output.log("\nThen start your dev server — the agent is live in your app.");
    output.log("Verify everything: `npx vendo doctor` (it can start the server and run a live turn).");

    // Agent tail (agent-install-dx): the --yes-or-non-TTY path is agent-driven
    // — the run's FINAL block is the repo-specific pointers an agent parses.
    // Interactive human runs keep the clack-style output untouched; --agent
    // never reaches here (its read-only JSON plan returned above).
    if (options.yes === true || !interactive) {
      output.log("\nAgent tail:");
      const tail = await agentTailLines({ root, framework: plan.framework, registryPath, compositionPath, authWired, cloudKeyMissing: credential.rung === "none" });
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
