import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  extractServerActions,
  mergeOverrides,
  serverActionRegistrations,
  vendoSync,
  type ExtractedTool,
  type OverridesFile,
  type ServerActionRegistration,
} from "@vendoai/actions";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { VendoTheme } from "@vendoai/core";
import type { Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";
import { runCloudStep, type CloudStepOptions } from "./cloud-init.js";
import { APPLY_COMMAND, composeDelegatedInstructions, EXTRACTION_DRAFT_JSON_SCHEMA } from "./extract/delegate.js";
import { askYesNo, runAiExtraction, type AiExtractionOptions } from "./extract/extraction.js";
import type { StaticTool } from "./extract/stages.js";
import { resolveDevCredential, describeDevCredential, type DevCredential } from "../dev-creds/resolve.js";
import { detectFramework, detectVendoWiring, type HostFramework } from "./framework.js";
import { createPrettyOutput, usePrettyOutput, type PrettyOutput } from "./pretty.js";
import { devModel, NO_CREDENTIAL_MESSAGE } from "../dev-creds/model.js";
import { contrastingText } from "./theme/color.js";
import {
  extractTheme as extractThemeSlots,
  validateSlotValue,
  type ThemeSlotValues,
  type ThemeSummary,
} from "./theme/extract-theme.js";
import {
  consoleOutput,
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
  /** Test seam: interactivity override for the auth confirm (default: TTY),
      mirroring runAiExtraction's `interactive`. */
  interactive?: boolean;
  /** Test seam: the theme LLM pass's model; default rides the refine seam. */
  themeModel?: () => Promise<LanguageModel>;
  /** Uncertain-slot review — asked ONLY when the model reports uncertainty. */
  themeReview?: (summary: ThemeSummary) => Promise<Record<string, string>>;
}

/**
 * Theme extraction's model rides the devModel ladder — the same env resolution
 * the runtime composes when `model` is omitted: provider env keys, then
 * VENDO_API_KEY via the Cloud gateway. That is what makes the same-run pickup
 * real: a starter key minted moments earlier in this init powers this pass.
 * No credential throws the honest instructions instead of constructing a model
 * that can only fail later; total failure is handled by extractTheme's
 * graceful degradation to reported defaults.
 */
function themeModelResolver(root: string, env: Record<string, string | undefined>): () => Promise<LanguageModel> {
  return async () => {
    const credential = await resolveDevCredential({ env });
    if (credential.rung === "none") throw new Error(NO_CREDENTIAL_MESSAGE);
    return devModel({ root, env });
  };
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

async function appDirectory(root: string): Promise<string> {
  if (await exists(join(root, "src", "app"))) return join(root, "src", "app");
  return join(root, "app");
}

/** The auth families init detects in package.json (09-vendo §2.1). Preset
    names double as the zero-arg `@vendoai/vendo/server` export names. */
type AuthPresetName = "authJs" | "clerk" | "supabase" | "auth0";

interface AuthMatch {
  preset: AuthPresetName;
  dependency: string;
}

interface AuthDetection {
  /** Exactly one family matched — the preset init wires silently. */
  wired: AuthMatch | null;
  /** Every family that matched (for the ambiguity advisory). */
  matches: AuthMatch[];
}

const AUTH_FAMILIES: ReadonlyArray<{ preset: AuthPresetName; test: (dependency: string) => boolean }> = [
  { preset: "authJs", test: (dependency) => dependency === "next-auth" || dependency.startsWith("@auth/") },
  { preset: "clerk", test: (dependency) => dependency.startsWith("@clerk/") },
  { preset: "supabase", test: (dependency) => dependency.startsWith("@supabase/") },
  { preset: "auth0", test: (dependency) => dependency.startsWith("@auth0/") },
];

/** Silent auth-preset detection from the host's package.json (zero-question
    contract): one unambiguous family gets wired; none or several stay
    anonymous and become one advisory line (detection-as-advice). */
async function detectAuthPreset(root: string): Promise<AuthDetection> {
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
function authAdvisory(detection: AuthDetection, compositionPath: string): string | null {
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
function declinedAuthAdvisory(match: AuthMatch, compositionPath: string): string {
  return `Auth: left anonymous. To wire ${match.dependency} later, add one line in ${compositionPath}: auth: ${match.preset}().`;
}

type ConfirmAuth = (question: string, defaultYes: boolean) => Promise<boolean>;

/** Detect + confirm: in interactive runs, exactly one detected family gets
    ONE calm [Y/n] question before anything is written (Enter accepts).
    Without a confirm (non-interactive, --yes, --agent) silent detection
    stands — a default has to exist. None/ambiguous never ask: nothing is
    certain enough to confirm, the advisory line covers it. */
async function resolveScaffoldAuth(
  root: string,
  compositionPath: string,
  confirmAuth: ConfirmAuth | undefined,
): Promise<{ wired: AuthMatch | null; advice: string | null }> {
  const detection = await detectAuthPreset(root);
  if (detection.wired === null || confirmAuth === undefined) {
    return { wired: detection.wired, advice: authAdvisory(detection, compositionPath) };
  }
  const accepted = await confirmAuth(
    `Detected ${detection.wired.dependency} — wire auth: ${detection.wired.preset}()?`,
    true,
  );
  return accepted
    ? { wired: detection.wired, advice: null }
    : { wired: null, advice: declinedAuthAdvisory(detection.wired, compositionPath) };
}

/** The wired preset line plus its escape-hatch comment. */
function authConfigLines(auth: AuthMatch): string {
  return `  // Detected ${auth.dependency} — ${auth.preset}() fills the identity seams\n` +
    `  // (request→user, actAs, door OAuth); options and the per-seam escape\n` +
    `  // hatch: docs/act-as-presets.md.\n` +
    `  auth: ${auth.preset}(),\n`;
}

/** The empty shared registry (one file, two consumers): `createVendo` reads it
    as `catalog` (data fields only), `<VendoRoot components={registry}>` reads
    the component references. Generated only while absent — never clobbered. */
function registrySource(variant: "tsx" | "mjs"): string {
  const header = `/**\n` +
    ` * The Vendo component registry — generated empty by \`vendo init\`, then yours.\n` +
    ` * One file, two consumers: \`createVendo\` takes this object as \`catalog\` and\n` +
    ` * reads only the data fields (description, props, examples); <VendoRoot\n` +
    ` * components={registry}> takes the same object and reads only the component\n` +
    ` * references. There is no second map to keep in sync.\n` +
    ` *\n` +
    ` * Add entries keyed by component name, e.g.:\n` +
    ` *\n` +
    ` *   SpendingDonut: {\n` +
    ` *     component: SpendingDonut,\n` +
    ` *     description: "Spending by category. Use for where-did-my-money-go requests.",\n` +
    ` *     props: z.object({\n` +
    ` *       slices: z.array(z.object({ category: z.string(), amount: z.number() })),\n` +
    ` *     }),\n` +
    ` *     examples: ['{"slices":[{"category":"dining","amount":342.18}]}'],\n` +
    ` *   },\n` +
    ` *\n` +
    ` * (\`props\` is an optional zod schema; a schema-less entry is legal.)\n` +
    ` */\n`;
  return variant === "tsx"
    ? `${header}import type { ComponentRegistry } from "@vendoai/core";\n\nexport const registry = {} satisfies ComponentRegistry;\n`
    : `${header}export const registry = {};\n`;
}

function routeSource(options: { serverActions: boolean; auth: AuthMatch | null; registrySpecifier: string }): string {
  const named = [...(options.auth === null ? [] : [options.auth.preset]), "createVendo", "nextVendoHandler"].sort();
  return `import { ${named.join(", ")} } from "@vendoai/vendo/server";\n` +
    (options.serverActions ? `import { serverActions } from "./vendo-actions";\n` : "") +
    `import { registry } from ${JSON.stringify(options.registrySpecifier)};\n` +
    `\nconst vendo = createVendo({\n` +
    (options.auth === null ? `  principal: async () => null,\n` : authConfigLines(options.auth)) +
    `  catalog: registry,\n` +
    (options.serverActions ? `  serverActions,\n` : "") +
    `});\n\n` +
    `export const { GET, POST, DELETE } = nextVendoHandler(vendo);\n`;
}

/** Best-effort detection of the host's registrable server actions for the
 * wiring map. Failure degrades to no map — sync reports extraction problems
 * loudly, and runtime execution fails closed on the missing registration. */
async function wiringServerActions(root: string): Promise<ServerActionRegistration[]> {
  try {
    const { tools } = await extractServerActions(root);
    return serverActionRegistrations(tools);
  } catch {
    return [];
  }
}

/**
 * The generated server-action registration map (04-actions §1, ENG-248): the
 * wiring file imports each detected `"use server"` action module and passes
 * the map into `createVendo({ serverActions })`. Deterministic content —
 * sorted registrations, stable aliases — so re-init stays idempotent.
 */
function serverActionsModuleSource(root: string, wiringDir: string, registrations: ServerActionRegistration[]): string {
  const header = `/**\n` +
    ` * Server-action registration map — generated by \`vendo init\`; re-run init\n` +
    ` * when the "use server" surface changes. createVendo dispatches\n` +
    ` * server-action tools in-process through this map; an action missing here\n` +
    ` * fails closed at execution time (no work performed).\n` +
    ` */\n`;
  if (registrations.length === 0) return `${header}export const serverActions = {};\n`;
  const imports: string[] = [];
  const entries: string[] = [];
  registrations.forEach((registration, index) => {
    const alias = `action${index}`;
    const target = relative(wiringDir, join(root, registration.module))
      .split(sep).join("/")
      .replace(/\.(?:tsx|ts|jsx|js)$/, "");
    const specifier = target.startsWith(".") ? target : `./${target}`;
    imports.push(registration.exportName === "default"
      ? `import ${alias} from ${JSON.stringify(specifier)};`
      : `import { ${registration.exportName} as ${alias} } from ${JSON.stringify(specifier)};`);
    entries.push(`  ${JSON.stringify(`${registration.module}#${registration.exportName}`)}: ${alias},`);
  });
  return `${header}${imports.join("\n")}\n\n` +
    `export const serverActions = {\n${entries.join("\n")}\n};\n`;
}

function expressServerSource(typescript: boolean, auth: AuthMatch | null = null): string {
  const imports = typescript
    ? `import { once } from "node:events";\n` +
      `import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";\n` +
      `import { Readable } from "node:stream";\n`
    : `import { once } from "node:events";\n` +
      `import { Readable } from "node:stream";\n`;
  const types = typescript
    ? `\ntype ExpressRequest = IncomingMessage & { originalUrl?: string };\n` +
      `type ExpressNext = (error?: unknown) => void;\n`
    : "";
  const signatures = typescript
    ? {
        requestHeaders: `(headers: IncomingHttpHeaders): Headers`,
        absoluteUrl: `(request: ExpressRequest): string`,
        sendResponse: `(source: Response, target: ServerResponse): Promise<void>`,
        handle: `(request: ExpressRequest, response: ServerResponse): Promise<void>`,
        mountReturn: `: (request: ExpressRequest, response: ServerResponse, next: ExpressNext) => void`,
      }
    : { requestHeaders: "(headers)", absoluteUrl: "(request)", sendResponse: "(source, target)", handle: "(request, response)", mountReturn: "" };
  const requestInit = typescript
    ? `  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(request.headers) };\n`
    : `  const init = { method, headers: requestHeaders(request.headers) };\n`;
  const body = typescript
    ? `    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;\n`
    : `    init.body = Readable.toWeb(request);\n`;

  // The client-entry hint mirrors the host's language: the TS variant needs the
  // VendoTheme cast (JSON-module literals widen to string), the JS variant must
  // not show type-only syntax a JavaScript host cannot paste.
  const registrySpecifier = typescript ? "./registry" : "./registry.mjs";
  const clientHint = typescript
    ? ` *   // in the client entry — theme.json adopts the host brand (08 §4);\n` +
      ` *   // the cast narrows TypeScript's widened JSON-module string literals:\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import { registry } from "<path-to>/vendo/registry";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   import type { VendoTheme } from "@vendoai/vendo";\n` +
      ` *   root.render(<VendoRoot components={registry} theme={theme as VendoTheme}><App /></VendoRoot>);\n`
    : ` *   // in the client entry — theme.json adopts the host brand (08 §4):\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import { registry } from "<path-to>/vendo/registry.mjs";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   root.render(<VendoRoot components={registry} theme={theme}><App /></VendoRoot>);\n`;
  const serverNamed = [...(auth === null ? [] : [auth.preset]), "createVendo"].sort();

  return `/**\n` +
    ` * Add these wiring lines in your host:\n` +
    ` *   app.use("/api/vendo", mountVendo());\n` +
    clientHint +
    ` */\n` +
    imports +
    `import { ${serverNamed.join(", ")} } from "@vendoai/vendo/server";\n` +
    `import { registry } from ${JSON.stringify(registrySpecifier)};\n` +
    types +
    `\nconst vendo = createVendo({\n` +
    (auth === null ? `  principal: async () => null,\n` : authConfigLines(auth)) +
    `  catalog: registry,\n` +
    `});\n\n` +
    `function requestHeaders${signatures.requestHeaders} {\n` +
    `  const result = new Headers();\n` +
    `  for (const [name, value] of Object.entries(headers)) {\n` +
    `    if (Array.isArray(value)) for (const item of value) result.append(name, item);\n` +
    `    else if (value !== undefined) result.set(name, value);\n` +
    `  }\n` +
    `  return result;\n` +
    `}\n\n` +
    `function absoluteUrl${signatures.absoluteUrl} {\n` +
    `  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;\n` +
    `  const protocol = encrypted ? "https" : "http";\n` +
    `  const host = request.headers.host ?? "localhost";\n` +
    `  // Behind a trusted proxy, set VENDO_BASE_URL explicitly or validate forwarded headers in the host.\n` +
    `  return new URL(request.originalUrl ?? request.url ?? "/", \`${"${protocol}"}://${"${host}"}\`).href;\n` +
    `}\n\n` +
    `async function sendResponse${signatures.sendResponse} {\n` +
    `  target.statusCode = source.status;\n` +
    `  source.headers.forEach((value, name) => {\n` +
    `    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);\n` +
    `  });\n` +
    `  const getSetCookie = (source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;\n` +
    `  const fallbackCookie = source.headers.get("set-cookie");\n` +
    `  const cookies = typeof getSetCookie === "function"\n` +
    `    ? getSetCookie.call(source.headers)\n` +
    `    : fallbackCookie === null ? [] : [fallbackCookie];\n` +
    `  if (cookies.length > 0) target.setHeader("set-cookie", cookies);\n` +
    `  if (source.body === null) {\n` +
    `    target.end();\n` +
    `    return;\n` +
    `  }\n` +
    `  target.flushHeaders();\n` +
    `  const reader = source.body.getReader();\n` +
    `  try {\n` +
    `    while (true) {\n` +
    `      const chunk = await reader.read();\n` +
    `      if (chunk.done) break;\n` +
    `      if (!target.write(chunk.value)) await once(target, "drain");\n` +
    `    }\n` +
    `    target.end();\n` +
    `  } finally {\n` +
    `    reader.releaseLock();\n` +
    `  }\n` +
    `}\n\n` +
    `async function handle${signatures.handle} {\n` +
    `  const method = request.method ?? "GET";\n` +
    requestInit +
    `  if (method !== "GET" && method !== "HEAD") {\n` +
    body +
    `    init.duplex = "half";\n` +
    `  }\n` +
    `  await sendResponse(await vendo.handler(new Request(absoluteUrl(request), init)), response);\n` +
    `}\n\n` +
    `export function mountVendo()${signatures.mountReturn} {\n` +
    `  return (request, response, next) => {\n` +
    `    void handle(request, response).catch(next);\n` +
    `  };\n` +
    `}\n`;
}

const VENDO_ENV_EXAMPLE =
  "# Trusted host origin for same-origin API calls. Dev trusts the request's own\n" +
  "# origin automatically; production fails loud without this set (a credential-\n" +
  "# forwarding call errors instead of silently running unauthenticated).\n" +
  "VENDO_BASE_URL=http://localhost:3000\n" +
  "# Model key — REQUIRED in production. In dev, `vendo init` can mint a free starter key instead.\n" +
  "# ANTHROPIC_API_KEY=\n";

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
  if (importsMap && passesActions) return null; // already wired

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
  if (!passesActions) {
    next = next.replace(/createVendo\(\s*\{/, (match) => `${match}\n  serverActions,`);
  }
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

async function buildPlan(options: InitOptions, confirmAuth?: ConfirmAuth): Promise<{ plan: InitPlan; changes: PlannedChange[]; manualSteps: string[]; authAdvice: string | null }> {
  const root = resolve(options.targetDir);
  const framework = await detectFramework(root);
  const changes: PlannedChange[] = [];
  let authAdvice: string | null = null;
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
      }
      if (scaffolding) {
        const path = relative(root, server);
        // Detect + confirm happens only here — fresh composition creation —
        // so a re-run before the manual <VendoRoot> paste neither asks nor
        // re-fires the advisory after "Already wired".
        const auth = await resolveScaffoldAuth(root, path, confirmAuth);
        const serverAfter = expressServerSource(typescript, auth.wired);
        changes.push({ absolute: server, path, before: null, after: serverAfter, diff: diff(path, null, serverAfter) });
        authAdvice = auth.advice;
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
      const auth = await resolveScaffoldAuth(root, path, confirmAuth);
      const registrySpecifier = relative(dirname(route), join(dirname(app), "vendo", "registry")).split(sep).join("/");
      const routeAfter = routeSource({ serverActions: registrations.length > 0, auth: auth.wired, registrySpecifier });
      changes.push({ absolute: route, path, before: routeBefore, after: routeAfter, diff: diff(path, routeBefore, routeAfter) });
      authAdvice = auth.advice;
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
    target) — the same-run pickup reads the freshly minted key back from disk. */
async function envLocalValue(root: string, name: string): Promise<string | null> {
  const raw = await readOptional(join(root, ".env.local"));
  const match = raw?.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match?.[1] ?? null;
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

function telemetryFor(options: InitOptions, output: Output): Telemetry {
  return toolingTelemetry({ ...options.telemetry, log: (message) => output.log(message) });
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
  const confirmAuth = options.yes === true || !interactive
    ? undefined
    : (options.confirmAuth ?? (pretty === null ? askYesNo : pretty.confirm));
  const { plan, changes, manualSteps, authAdvice } = await buildPlan(options, confirmAuth);
  const telemetry = telemetryFor(options, output);
  await telemetry.track("init_started", { framework: plan.framework });

  try {
    // Key first (product order fix): the model-credential story — env keys,
    // else the Vendo Cloud offer — runs BEFORE the AI-assisted passes, so a
    // starter key minted here powers the SAME run's theme model pass and AI
    // polish instead of those passes reporting "no model" while the offer
    // waits below them. --yes / non-interactive semantics are unchanged.
    let credential = await (options.resolveCredential ?? resolveDevCredential)({ env });
    if (credential.rung === "env-key") {
      output.log(`Model: ${describeDevCredential(credential)} — production uses this same key server-side.`);
    }
    const cloud = await runCloudStep({
      root,
      output,
      yes: options.yes === true,
      credential,
      ...(pretty === null ? {} : { confirm: pretty.confirm }),
      ...(options.cloud ?? {}),
    });
    // Same-run pickup: a freshly minted starter key lands in .env.local, not
    // in this process's env — merge it into the env every credential consumer
    // below reads (theme model pass, AI polish, the end-of-run reminder).
    let effectiveEnv = env;
    if (cloud.wroteEnvLocal) {
      const minted = await envLocalValue(root, "VENDO_API_KEY");
      if (minted !== null) {
        effectiveEnv = { ...env, VENDO_API_KEY: minted };
        credential = await (options.resolveCredential ?? resolveDevCredential)({ env: effectiveEnv });
      }
    }

    // Wire — apply the bounded change set and list it. No gates, no prompts.
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
      "Describe this product, its users, and the jobs the agent should help them complete.\n",
      options.force === true,
    );
    // Exact-or-model theme extraction (§B2). Skipped entirely when a
    // theme.json already exists (it is the editable source of truth) so
    // reruns never spend a model call or overwrite hand edits.
    const themePath = join(root, ".vendo", "theme.json");
    if (options.force === true || !(await exists(themePath))) {
      pretty?.spin("Capturing your theme");
      const summary = await extractThemeSlots(root, {
        resolveModel: options.themeModel ?? themeModelResolver(root, effectiveEnv),
      });
      pretty?.stopSpin();
      if (summary.uncertain.length > 0 && options.yes !== true) {
        const overrides = await (options.themeReview ?? defaultThemeReview)(summary);
        for (const [slot, raw] of Object.entries(overrides)) {
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
        // was contrast-derived, or still the neutral default because the model
        // omitted the accent too. Re-derive against the new accent; an explicit
        // token or a direct human/model answer stays authoritative.
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
    await writeIfMissing(join(root, ".vendo", "data", ".gitignore"), "*\n!.gitignore\n", options.force === true);

    pretty?.spin("Learning your API surface");
    const report = await vendoSync({ root, out: join(root, ".vendo") });
    pretty?.stopSpin();
    for (const warning of report.warnings) output.error(`warning: ${warning}`);

    let toolCount = 0;
    try {
      const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8")) as { tools?: unknown[] };
      toolCount = tools.tools?.length ?? 0;
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
    const polish = await runAiExtraction({
      root,
      output,
      env: effectiveEnv,
      yes: options.yes === true,
      ...(options.force === true ? { force: true } : {}),
      ...(pretty === null ? {} : { confirm: pretty.confirm }),
      ...(options.extract ?? {}),
    });
    if (polish.ran) {
      const resynced = await vendoSync({ root, out: join(root, ".vendo") });
      for (const warning of resynced.warnings) output.error(`warning: ${warning}`);
    }

    await telemetry.track("init_completed", {
      framework: plan.framework,
      command: "init",
      toolCount,
      durationMs: Date.now() - started,
    });

    // The one short Cloud reminder in the end-of-run summary — ONLY while no
    // key exists (the full emphasized block already ran up top; no repeat).
    if (credential.rung === "none") {
      output.log("No model key yet: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY in .env.local, or run `vendo cloud login` for a free dev key.");
    }

    // Done — the one paste that is the user's, then their own dev server.
    output.log("\nLast steps are yours:");
    for (const line of manualSteps) output.log(`  ${line}`);
    output.log("\nThen start your dev server — the agent is live in your app.");
    output.log("Verify everything: `npx vendo doctor` (it can start the server and run a live turn).");
    pretty?.done(Date.now() - started, true);
    return 0;
  } catch (error) {
    await telemetry.track("init_failed", { framework: plan.framework, failedStep: "wiring" });
    await telemetry.track("error_class", { errorClass: errorClass(error) });
    output.error(error instanceof Error ? error.message : "vendo init failed");
    pretty?.done(Date.now() - started, false);
    return 1;
  }
}
