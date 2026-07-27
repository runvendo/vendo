import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { operatorNotesName } from "./create.js";
import type { ExecFn } from "./deploy.js";
import { defaultExec } from "./deploy.js";
import type { ResearchReport } from "./research.js";
import { appBuildCommand } from "./scratch.js";

/**
 * The creative-rewrite stage of `demo:pipeline` — replaces the old single
 * serial creator-agent pass with three parts:
 *
 *  (a) a MECHANICAL brand-token transform: exact colors/fonts/radius from
 *      research.json into `.vendo/theme.json`, the harvested logo into
 *      `public/brand/`, and a BRAND.md evidence brief — deterministic, no
 *      model call;
 *  (b) per-screen creative rewrites as PARALLEL headless `claude` CLI
 *      invocations (the PATH-CLI harness pattern — same recipe as
 *      packages/vendo claude-cli-harness and the corpus install-eval agent),
 *      one plan agent first, then domain / shell+home / extra screens / beats
 *      agents concurrently, each with an EXPLICIT disjoint file list;
 *  (c) an assembly check: fenced plumbing unchanged (hash-verified, restored
 *      if an agent strayed), demo.config.json parses with no TODO(creator)
 *      left, and the app builds — with a capped repair-agent loop on failure.
 */

// ---------------------------------------------------------------------------
// (a) Brand tokens — deterministic
// ---------------------------------------------------------------------------

/** Shape of the template's `.vendo/theme.json` (validated app-side by
 * `src/vendo/theme.ts`; the build fails loudly on drift). */
export interface ThemeTokens {
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    danger: string;
    border: string;
  };
  typography: { fontFamily: string; baseSize: string };
  radius: { small: string; medium: string; large: string };
  density: string;
  motion: string;
}

/** Computed-style colors arrive as rgb()/rgba(); theme tokens want hex.
 * Fully transparent values and exotic spaces (oklch, var()) return undefined
 * — the token then keeps its template default rather than guessing. */
export function cssColorToHex(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((c) => c + c).join("")}`.toUpperCase();
  }
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(trimmed);
  if (match === null) return undefined;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha === 0) return undefined;
  const toHex = (part: string): string => Math.min(255, Number(part)).toString(16).padStart(2, "0");
  return `#${toHex(match[1] as string)}${toHex(match[2] as string)}${toHex(match[3] as string)}`.toUpperCase();
}

function firstRoleColor(report: ResearchReport, role: string): string | undefined {
  for (const page of report.pages) {
    if ("error" in page) continue;
    for (const entry of page.colorRoles) {
      if (entry.role === role) {
        const hex = cssColorToHex(entry.color);
        if (hex !== undefined) return hex;
      }
    }
  }
  return undefined;
}

function firstThemeColor(report: ResearchReport): string | undefined {
  for (const page of report.pages) {
    if ("error" in page) continue;
    if (page.themeColor !== null) {
      const hex = cssColorToHex(page.themeColor);
      if (hex !== undefined) return hex;
    }
  }
  return undefined;
}

/** First parseable non-zero button radius across the evidence, in px. */
function sampledButtonRadius(report: ResearchReport): number | undefined {
  for (const page of report.pages) {
    if ("error" in page) continue;
    for (const sample of page.samples) {
      if (!sample.target.startsWith("button")) continue;
      const match = /^([\d.]+)px/.exec(sample.borderRadius.trim());
      const value = match === null ? Number.NaN : Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

export interface DerivedTheme {
  theme: ThemeTokens;
  /** What was derived from evidence vs kept at the template default —
   * rendered into BRAND.md so agents (and the judge) know the provenance. */
  notes: string[];
}

/** Maps research evidence onto the template's token seam. Every token that
 * has real evidence gets the EXACT sampled value (the fidelity doctrine:
 * hexes are copied, never eyeballed); everything else keeps the template
 * default and is flagged in the notes. */
export function deriveThemeTokens(report: ResearchReport, base: ThemeTokens): DerivedTheme {
  const notes: string[] = [];
  const colors = { ...base.colors };

  const apply = (token: keyof ThemeTokens["colors"], value: string | undefined, provenance: string): void => {
    if (value === undefined) {
      notes.push(`${token}: no usable evidence — kept template default ${colors[token]}`);
      return;
    }
    colors[token] = value;
    notes.push(`${token}: ${value} (${provenance})`);
  };

  apply("background", firstRoleColor(report, "body-bg"), "sampled body background");
  apply("text", firstRoleColor(report, "body-text"), "sampled body text");
  const accent = firstRoleColor(report, "primary-button-bg") ?? firstThemeColor(report) ?? firstRoleColor(report, "link");
  apply("accent", accent, "primary button bg, else meta theme-color, else link color");
  apply("accentText", firstRoleColor(report, "primary-button-text"), "sampled primary button text");

  const typography = { ...base.typography };
  const family = report.fonts.families[0];
  if (family !== undefined && family !== "") {
    const quoted = family.includes(" ") ? `"${family}"` : family;
    typography.fontFamily = `${quoted}, ui-sans-serif, system-ui, sans-serif`;
    notes.push(`fontFamily: ${family} (first resolved family in the evidence)`);
  } else {
    notes.push("fontFamily: no font evidence — kept template default");
  }

  const radius = { ...base.radius };
  const sampled = sampledButtonRadius(report);
  if (sampled !== undefined) {
    const medium = Math.max(2, Math.min(24, Math.round(sampled)));
    radius.small = `${Math.max(2, Math.round(medium / 2))}px`;
    radius.medium = `${medium}px`;
    radius.large = `${Math.min(28, Math.round(medium * 1.5))}px`;
    notes.push(`radius: ${medium}px medium from a sampled button (${sampled}px raw, clamped 2-24)`);
  } else {
    notes.push("radius: no button radius evidence — kept template defaults");
  }

  return { theme: { ...base, colors, typography, radius }, notes };
}

/** Best harvested logo, as a RESEARCH-relative path: header/nav SVGs first
 * (the real product mark), then any saved logo, then the SVG favicon. */
export function pickLogoAsset(report: ResearchReport): string | undefined {
  const saved = report.pages.flatMap((page) => ("error" in page ? [] : page.assets))
    .filter((asset) => asset.file !== null);
  const score = (asset: (typeof saved)[number]): number => {
    const file = asset.file as string;
    if (asset.kind === "logo") {
      const headerish = asset.source.startsWith("header") || asset.source.startsWith("nav");
      const svg = file.endsWith(".svg");
      return (headerish ? 0 : 2) + (svg ? 0 : 1);
    }
    if (asset.kind === "favicon" && file.endsWith(".svg")) return 4;
    return 5 + (asset.kind === "favicon" ? 0 : 1);
  };
  const best = [...saved].sort((a, b) => score(a) - score(b))[0];
  if (best === undefined || score(best) >= 5) return undefined;
  return best.file as string;
}

export interface BrandBriefOptions {
  prospect: string;
  url: string;
  derived: DerivedTheme;
  /** App-relative path the logo was copied to (e.g. "public/brand/logo.svg"), if found. */
  logoPath?: string;
  report: ResearchReport;
  /** Contents of RESEARCH/OPERATOR-NOTES.md (`demo:create --notes`), if any. */
  operatorNotes?: string;
}

/** RESEARCH/BRAND.md — the one evidence brief every rewrite agent reads
 * first. Deterministic render of the deterministic transform's output. */
export function renderBrandBrief(options: BrandBriefOptions): string {
  const { prospect, url, derived, logoPath, report, operatorNotes } = options;
  const operatorLines = report.operatorScreenshots.length === 0
    ? "- none provided"
    : report.operatorScreenshots.map((shot) => `- RESEARCH/${shot.file} (operator-provided — LOOK at this first; it usually shows the real logged-in product UI)`).join("\n");
  const pageLines = report.pages
    .map((page) => "error" in page
      ? `- ${page.url}: FAILED (${page.error})`
      : `- RESEARCH/${page.screenshots.fullPage}${page.botChallenge ? " (BOT CHALLENGE — junk evidence, ignore the pixels)" : ""} — ${page.url}`)
    .join("\n");
  return `# BRAND BRIEF — ${prospect}

Prospect site: ${url}
Generated mechanically from RESEARCH/research.json — exact sampled values, never eyeballed.
${operatorNotes === undefined ? "" : `
## OPERATOR NOTES — AUTHORITATIVE, they win every conflict

The operator has already studied this prospect. Everything below is
established fact about the product, not a suggestion: follow it literally,
and where it contradicts a general rule below (including "invent all data"),
the operator's note WINS. Anything the notes do not cover still follows the
normal rules.

${operatorNotes.trim()}
`}

## Applied theme tokens (.vendo/theme.json — ALREADY WRITTEN, do not edit it)

${derived.notes.map((note) => `- ${note}`).join("\n")}

## Logo

${logoPath === undefined
    ? "- NO usable logo was harvested. FIND the real logo in the RESEARCH screenshots and recreate the header wordmark faithfully in code (never a generic placeholder)."
    : `- Real logo copied to ${logoPath} — render it (e.g. <img src="/brand/${path.basename(logoPath)}" ...>) in the header/nav exactly where ${prospect} puts theirs.`}

## Fonts

- Families in evidence: ${report.fonts.families.length === 0 ? "(none)" : report.fonts.families.join(", ")}
- Webfont links: ${report.fonts.webfontLinks.length === 0 ? "(none)" : report.fonts.webfontLinks.join(" ")}
- Use the REAL font when freely loadable (Google Fonts, rsms Inter, other open source); NEVER pirate licensed font files — use the closest freely-available metric match and note the substitution.

## Evidence — LOOK at every image, operator screenshots first

Operator screenshots (top priority):
${operatorLines}

Captured pages:
${pageLines}
`;
}

// ---------------------------------------------------------------------------
// (b) Plan + parallel agents
// ---------------------------------------------------------------------------

export interface RewritePlanScreen {
  /** Lowercase slug, unique per screen; also the component dir name. */
  slug: string;
  /** Next.js route: "/" for the home/reference screen, "/<slug>" otherwise. */
  route: string;
  title: string;
  /** What the screen shows and which seeded data it renders. */
  purpose: string;
}

export interface RewritePlan {
  /** The domain entity replacing the template's "items" worked example. */
  entity: {
    /** PascalCase type name, e.g. "Issue". */
    name: string;
    /** File stem for src/server/<stem>.ts and the API route dir, e.g. "issues". */
    stem: string;
    /** The one consented mutation, e.g. "archiveIssue" / "closeIssue". */
    action: string;
    /** Field list (name: type — meaning) the seed and screens share. */
    fields: string[];
    /** 2-3 invented-but-plausible record names beats can reference. */
    sampleRecordNames: string[];
  };
  /** 2-4 screens; the FIRST is always the reference-screen clone at "/". */
  screens: RewritePlanScreen[];
  /** Sidebar/topbar nav labels, exactly as the real product names them. */
  nav: string[];
  /** One line describing the prospect's register (formal/playful/terse). */
  copyTone: string;
}

/** Parses + validates the plan agent's JSON (tolerates a ```json fence). */
export function parseRewritePlan(raw: string): RewritePlan {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`Plan agent did not return JSON:\n${raw.slice(0, 400)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Plan agent returned invalid JSON (${error instanceof Error ? error.message : String(error)}):\n${raw.slice(0, 400)}`);
  }
  const plan = parsed as RewritePlan;
  const fail = (reason: string): never => { throw new Error(`Plan agent output rejected: ${reason}`); };
  if (typeof plan.entity?.name !== "string" || plan.entity.name === "") fail("entity.name missing");
  if (typeof plan.entity.stem !== "string" || !/^[a-z][a-z0-9-]*$/.test(plan.entity.stem)) fail("entity.stem must be a lowercase slug");
  if (typeof plan.entity.action !== "string" || plan.entity.action === "") fail("entity.action missing");
  if (!Array.isArray(plan.entity.fields) || plan.entity.fields.length === 0) fail("entity.fields missing");
  if (!Array.isArray(plan.entity.sampleRecordNames) || plan.entity.sampleRecordNames.length === 0) fail("entity.sampleRecordNames missing");
  if (!Array.isArray(plan.screens) || plan.screens.length < 1 || plan.screens.length > 4) fail("screens must have 1-4 entries");
  if (plan.screens[0]?.route !== "/") fail('screens[0].route must be "/" (the reference-screen clone)');
  const slugs = new Set<string>();
  for (const screen of plan.screens) {
    if (!/^[a-z][a-z0-9-]*$/.test(screen.slug)) fail(`screen slug "${screen.slug}" must be a lowercase slug`);
    if (slugs.has(screen.slug)) fail(`duplicate screen slug "${screen.slug}"`);
    slugs.add(screen.slug);
    if (screen !== plan.screens[0] && screen.route !== `/${screen.slug}`) {
      fail(`screen "${screen.slug}" route must be "/${screen.slug}"`);
    }
  }
  if (!Array.isArray(plan.nav) || plan.nav.length === 0) fail("nav labels missing");
  if (typeof plan.copyTone !== "string" || plan.copyTone === "") fail("copyTone missing");
  return plan;
}

/** The fenced plumbing (playbook §1) — never touched by any agent; hashed
 * before the fan-out and restored + flagged if an agent strayed. package.json
 * is fenced too (its predev/prebuild `vendo sync .` scripts are load-bearing
 * and nothing creative lives there). */
export const fencedFiles = [
  // The injected demo login (inject-auth.ts) — the gate's "login works"
  // depends on it surviving the rewrite untouched.
  "middleware.ts",
  "src/app/login/route.ts",
  "package.json",
  "src/server/caps.ts",
  "src/server/http.ts",
  "src/server/prng.ts",
  "src/app/api/vendo/[...vendo]/route.ts",
  "src/app/demo-status/route.ts",
  "src/app/vendo/page.tsx",
  "src/vendo/server.ts",
  "src/vendo/theme.ts",
  "src/vendo/request.ts",
  "src/vendo/host-components.tsx",
  "src/components/demo-chrome.tsx",
  "src/components/demo-panel.tsx",
  "src/components/suggestion-chips.tsx",
  "src/components/vendo/VendoRoot.tsx",
  "src/lib/demo-config.ts",
  "src/lib/demo-config-loader.ts",
] as const;

export interface AgentJob {
  name: string;
  prompt: string;
  /** App-relative roots this agent may create/edit — the ONLY writable area.
   * Disjointness across jobs is asserted before anything runs. */
  ownedRoots: string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  /** claude model flag; screens/domain default comes from the caller. */
  model: string;
}

/** Any overlap between two agents' writable roots = the split is broken;
 * refuse to run rather than let parallel edits race. */
export function assertDisjointOwnership(jobs: readonly AgentJob[]): void {
  for (const a of jobs) {
    for (const b of jobs) {
      if (a === b) continue;
      for (const rootA of a.ownedRoots) {
        for (const rootB of b.ownedRoots) {
          if (rootA === rootB || rootB.startsWith(`${rootA}/`)) {
            throw new Error(`Agent file split overlaps: "${a.name}" owns ${rootA}, "${b.name}" owns ${rootB} — redesign the split`);
          }
        }
      }
    }
  }
}

const sharedRules = (prospect: string, operatorNotes?: string): string => `THE BAR: EXACT brand mimicry of ${prospect} — a person who uses their product should recognize this as theirs at a glance. Generic-ish output fails the visual judge and wastes a fix round.
${operatorNotes === undefined ? "" : `
OPERATOR NOTES — AUTHORITATIVE. The operator has already studied this product; these are established facts, and where one contradicts any rule below (including "ALL seed data is INVENTED") the operator's note WINS. Implement them literally.

${operatorNotes.trim()}
`}
Non-negotiable rules:
- Read RESEARCH/BRAND.md and RESEARCH/PLAN.json FIRST, then LOOK at the evidence images they list (operator screenshots outrank everything).
- ALL seed data is INVENTED${operatorNotes === undefined ? "" : ", EXCEPT anything the operator notes above pin down"}. No real people, names, emails, or records from any source material. Evidence informs STYLE, never DATA. No Foo/Bar/Lorem/Alpha/Bravo placeholders.
- NEVER touch these fenced files (guard plumbing, hash-verified after you run): ${fencedFiles.join(", ")}. Do not edit .vendo/theme.json either — it is already written with exact sampled values.
- ONLY create or edit files inside YOUR file list below. Other agents own the rest and run concurrently.
- Use Tailwind classes + the CSS custom properties the template exposes; the theme tokens carry the brand.
- Host API routes answer through ok() in the fenced src/server/http.ts, which wraps EVERY body as { data: ... }. A screen that does \`const rows = await res.json()\` and treats it as an array renders permanently empty — unwrap \`.data\`. (This shipped once: a Reports screen that looked perfect and listed nothing.)`;

export interface AgentJobsOptions {
  prospect: string;
  plan: RewritePlan;
  /** Default model for the fan-out agents. */
  model: string;
  /** Model for the fidelity-critical shell/home agent. */
  shellModel: string;
  /** Operator instructions (RESEARCH/OPERATOR-NOTES.md), inlined into every job. */
  operatorNotes?: string;
}

/** Compiles the plan into the parallel fan-out: domain, shell+home,
 * one agent per extra screen, beats. Static split, disjoint by construction
 * — asserted anyway. */
export function buildAgentJobs(options: AgentJobsOptions): AgentJob[] {
  const { prospect, plan, model, shellModel, operatorNotes } = options;
  const rules = sharedRules(prospect, operatorNotes);
  const planJson = JSON.stringify(plan, null, 2);
  const [home, ...extraScreens] = plan.screens;

  const jobs: AgentJob[] = [
    {
      name: "domain",
      ownedRoots: ["openapi.json", "src/server/types.ts", "src/server/store.ts", "src/server/seed.ts", `src/server/${plan.entity.stem}.ts`, "src/server/items.ts", "src/server/__tests__", "src/app/api"],
      maxBudgetUsd: 6,
      timeoutMs: 20 * 60 * 1000,
      model,
      prompt: `You are the DOMAIN agent rewriting a Vendo demo-template clone into a ${prospect} demo.

${rules}

THE PLAN (already decided — implement it exactly):
${planJson}

YOUR TASK — replace the template's "items" worked example with the ${plan.entity.name} entity:
- src/server/types.ts: the ${plan.entity.name} type with the plan's fields.
- src/server/seed.ts: deterministic seed via the existing mulberry32 prng (KEEP src/server/prng.ts as-is). 10-20 invented, domain-plausible records — right magnitudes, coherent dates (created < updated, nothing after today), realistic status spread, and include the plan's sampleRecordNames verbatim so the beats can name them. Those sample records must seed in a state "${plan.entity.action}" can STILL ACT ON (not already archived/closed/voided/paid) — the take-action beat names one, and an already-actioned record makes the agent correctly decline, so no consent card appears and the beat dies. Pin their state explicitly rather than leaving it to the prng.
- src/server/store.ts: keep the in-memory store pattern, typed to the new entity.
- src/server/${plan.entity.stem}.ts: list + the one mutation "${plan.entity.action}" (replace src/server/items.ts — delete its content by rewriting it to re-export from the new module, or empty it to a comment; you own it).
- src/server/__tests__/: update the seed/entity tests to the new domain (same coverage shape as the template's).
- src/app/api/: replace the /api/items routes with /api/${plan.entity.stem} (list) and the mutation route, same handler pattern; keep /api/vendo/** untouched (fenced).
- openapi.json: declare the new operations (operationId matching, x-vendo-formats for money fields in cents) — the build regenerates .vendo/tools.json from it.

YOUR FILE LIST (writable): openapi.json, src/server/* (except the fenced caps.ts/http.ts/prng.ts), src/server/__tests__/**, src/app/api/** (except src/app/api/vendo/**).`,
    },
    {
      name: "shell-home",
      ownedRoots: ["src/app/page.tsx", "src/app/layout.tsx", "src/app/globals.css", "src/components/shell", "src/components/home"],
      maxBudgetUsd: 8,
      timeoutMs: 20 * 60 * 1000,
      model: shellModel,
      prompt: `You are the SHELL+HOME agent rewriting a Vendo demo-template clone into a ${prospect} demo.

${rules}

THE PLAN (already decided — implement it exactly):
${planJson}

YOUR TASK — the app shell and the reference screen, the fidelity-critical surface:
- Pick the reference screen: the operator screenshot (or best real product-UI capture) named in BRAND.md's evidence list. src/app/page.tsx ("${home?.title ?? "home"}") must be a STRUCTURAL 1:1 clone of it: same regions, same nav items/labels (the plan's nav array), same column set, same header composition — populated from the seeded ${plan.entity.name} data (fetch from /api/${plan.entity.stem} or import the server store in a server component, following the template's existing pattern).
- src/app/layout.tsx + src/app/globals.css: the shared shell — real logo from public/brand/ in the header/sidebar exactly where ${prospect} puts theirs, the real font loaded (Google Fonts/open-source only — BRAND.md names it), exact token colors. Keep the DemoChrome mount and /vendo link wiring exactly as the template has them.
- Shared shell components go in src/components/shell/, home-screen components in src/components/home/.
- Nav entries for the plan's other screens link to their routes (other agents build those pages concurrently — link, don't build).

YOUR FILE LIST (writable): src/app/page.tsx, src/app/layout.tsx, src/app/globals.css, src/components/shell/**, src/components/home/**.`,
    },
    ...extraScreens.map((screen): AgentJob => ({
      name: `screen-${screen.slug}`,
      ownedRoots: [`src/app/${screen.slug}`, `src/components/${screen.slug}`],
      maxBudgetUsd: 5,
      timeoutMs: 20 * 60 * 1000,
      model,
      prompt: `You are the SCREEN agent for "${screen.title}" (${screen.route}) in a ${prospect} demo built from the Vendo demo-template.

${rules}

THE PLAN (already decided — implement it exactly):
${planJson}

YOUR TASK — one screen, brand-exact:
- src/app/${screen.slug}/page.tsx: ${screen.purpose} Rendered from the seeded ${plan.entity.name} data (fetch /api/${plan.entity.stem} or import the server store per the template pattern). Mirror ${prospect}'s real layout language for this surface (LOOK at the evidence; if no evidence shows this exact surface, extrapolate strictly from their visual system — density, radius, type scale).
- The shared shell (sidebar/header) is built concurrently by another agent as src/components/shell/* — import from there by the conventional names (e.g. a Shell or Sidebar component); if unsure, render your content inside a <main> and keep the coupling minimal.
- Your components live in src/components/${screen.slug}/.

YOUR FILE LIST (writable): src/app/${screen.slug}/**, src/components/${screen.slug}/**.`,
    })),
    {
      name: "beats",
      ownedRoots: ["demo.config.json", ".vendo/policy.json"],
      maxBudgetUsd: 2,
      timeoutMs: 8 * 60 * 1000,
      model,
      prompt: `You are the BEATS agent for a ${prospect} demo built from the Vendo demo-template.

${rules}

THE PLAN (already decided — implement it exactly):
${planJson}

YOUR TASK — demo.config.json ONLY (keep it parsing against the template schema; it is strict — no stray fields):
- Replace EVERY "TODO(creator): " prefix in prompts AND chips. Zero may remain.
- Keep the fixed 3-beat arc and the expectation declarations verbatim:
  1. generate-ui (expectsView: true): an IMPERATIVE UI-generation prompt over the seeded ${plan.entity.name} data — "Build me a dashboard of X — show Y and Z", never a question (question-form prompts get a markdown answer, no view, and fail verification).
  2. take-action (expectsApproval: true): a consented mutation naming a SPECIFIC seeded record from the plan's sampleRecordNames (e.g. "${plan.entity.action} ... '${plan.entity.sampleRecordNames[0] ?? ""}'") so the agent acts immediately instead of asking a clarifying question.
  3. save-app: save the generated view as a reusable app.
- Chips are short labels in ${prospect}'s vocabulary; prompts are the full sentences.
- caps stay set (20 turns / $5 unless the plan argues otherwise). Set expiresAt to a real UTC instant ~21 days out (not the 2099 placeholder).

ALSO .vendo/policy.json — keep its "rules" EXACTLY as they are and only APPEND to "directions". Directions are host steering the live agent reads on every turn, and they are the only thing that makes a GENERATED view speak ${prospect}'s language. Add one line for each fact that would otherwise render wrong:
- currency, when it is not US dollars — Money defaults to USD, so a rupee/euro/yen product needs 'every Money value must pass currency="XXX"', plus whether amounts are stored in minor units;
- the product's own vocabulary, so generated headings match the screens.
Take these from RESEARCH/BRAND.md (its OPERATOR NOTES section first). Add nothing you cannot point at in the evidence.

YOUR FILE LIST (writable): demo.config.json, .vendo/policy.json.`,
    },
  ];
  assertDisjointOwnership(jobs);
  return jobs;
}

export function buildPlanPrompt(options: { prospect: string; url: string; operatorNotes?: string }): string {
  return `You are the PLAN agent for a ${options.prospect} demo (prospect site ${options.url}) built from the Vendo demo-template.

Read RESEARCH/BRAND.md, RESEARCH/research.json and LOOK at every evidence image (operator screenshots first — they usually show the real logged-in product). Then decide the rebuild plan.
${options.operatorNotes === undefined ? "" : `
OPERATOR NOTES — AUTHORITATIVE. Already-established facts about this product; the plan must match them (nav labels, screens, vocabulary) rather than re-derive them:

${options.operatorNotes.trim()}
`}

Output ONLY a JSON object (no prose, no markdown fence) with exactly this shape:
{
  "entity": {
    "name": "<PascalCase domain entity replacing the template's Item, e.g. Issue>",
    "stem": "<lowercase file/route stem, e.g. issues>",
    "action": "<the one consented mutation, camelCase, e.g. closeIssue>",
    "fields": ["<name: type — meaning>", ...],
    "sampleRecordNames": ["<2-3 invented, domain-plausible record names>"]
  },
  "screens": [
    { "slug": "<slug>", "route": "/", "title": "<name>", "purpose": "<what it shows, which real screen it clones>" },
    ... 1-3 more with route "/<slug>" — total 2-4 screens covering the product surfaces visible in the evidence
  ],
  "nav": ["<the real product's nav labels, exactly as they appear>"],
  "copyTone": "<one line on the register: formal/playful/terse, vocabulary quirks>"
}

Rules: screens[0] is the reference-screen clone at "/" — pick the evidence image that best shows the real product UI and name it in its purpose. ALL sampleRecordNames are invented (no real customer data). The entity is the product's core noun (what the visible screens list and act on).`;
}

// ---------------------------------------------------------------------------
// Agent spawn (headless claude CLI — the PATH-CLI harness pattern)
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  name: string;
  code: number;
  /** Final text (the `result` field of --output-format json, or raw stdout). */
  output: string;
  costUsd?: number;
  timedOut: boolean;
}

export interface RunAgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Extra read-only run (the plan agent): no Write/Edit. */
  readOnly?: boolean;
  /** Aborting kills the agent subprocess (the pipeline's wall-clock cap). */
  signal?: AbortSignal;
}

export type RunAgentFn = (job: Pick<AgentJob, "name" | "prompt" | "maxBudgetUsd" | "timeoutMs" | "model">, options: RunAgentOptions) => Promise<AgentRunResult>;

export function buildClaudeArgs(job: Pick<AgentJob, "prompt" | "maxBudgetUsd" | "model">, options: { readOnly?: boolean } = {}): string[] {
  const tools = options.readOnly === true ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Write", "Edit"];
  return [
    "-p", job.prompt,
    "--output-format", "json",
    // The app dir is a disposable untracked clone; agents must write without
    // prompting. Tool allowlist still excludes Bash/Web/Task everywhere.
    "--permission-mode", "bypassPermissions",
    "--allowedTools", ...tools,
    "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
    "--setting-sources", "",
    "--model", job.model,
    "--max-budget-usd", String(job.maxBudgetUsd),
  ];
}

/** Extracts {result, total_cost_usd, is_error} from `claude --output-format
 * json` (shape live-verified against claude CLI 2.1.x). */
export function parseAgentOutput(stdout: string): { output: string; costUsd?: number; isError: boolean } {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
    return {
      output: typeof parsed.result === "string" ? parsed.result : stdout,
      isError: parsed.is_error === true,
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
    };
  } catch {
    return { output: stdout, isError: false };
  }
}

export const defaultRunAgent: RunAgentFn = (job, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", buildClaudeArgs(job, { readOnly: options.readOnly ?? false }), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, job.timeoutMs);
    const onAbort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Could not spawn the claude CLI for agent "${job.name}": ${error.message} — is claude on PATH?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const parsed = parseAgentOutput(stdout);
      // A budget-exceeded/errored run can still exit 0 — is_error is truth.
      const effectiveCode = (code ?? 1) !== 0 ? (code ?? 1) : parsed.isError ? 1 : 0;
      resolve({
        name: job.name,
        code: effectiveCode,
        output: parsed.output === "" ? stderr : parsed.output,
        ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
        timedOut,
      });
    });
  });

// ---------------------------------------------------------------------------
// (c) Assembly check
// ---------------------------------------------------------------------------

/** demo.config.json may not ship any TODO(creator) fence. */
export function hasCreatorTodos(configRaw: string): boolean {
  return configRaw.includes("TODO(creator)");
}

async function snapshotFencedFiles(appDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of fencedFiles) {
    const filePath = path.join(appDir, file);
    if (existsSync(filePath)) snapshot.set(file, await readFile(filePath, "utf8"));
  }
  return snapshot;
}

/** Compares the fenced plumbing against the pre-fan-out snapshot; restores
 * strays and returns their names (logged + flagged, run continues — the
 * restored content is what ships). */
export async function verifyFencedFiles(appDir: string, snapshot: Map<string, string>): Promise<string[]> {
  const violations: string[] = [];
  for (const [file, expected] of snapshot) {
    const filePath = path.join(appDir, file);
    const actual = existsSync(filePath) ? await readFile(filePath, "utf8") : undefined;
    if (actual !== expected) {
      violations.push(file);
      await writeFile(filePath, expected);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface RewriteArgs {
  prospect: string;
  url: string;
  /** The clone's package name (turbo build filter). */
  packageName: string;
}

export interface RewriteIo {
  repoRoot: string;
  appDir: string;
  exec?: ExecFn;
  runAgent?: RunAgentFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Timing hook — the pipeline passes its stage runner so rewrite substages
   * land in timings.json; defaults to a passthrough. */
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** The pipeline's wall-clock-cap signal: aborting kills agent subprocesses. */
  signal?: AbortSignal;
}

export interface RewriteResult {
  plan: RewritePlan;
  agents: AgentRunResult[];
  /** Fenced files an agent modified (restored from snapshot). */
  fencedViolations: string[];
  /** 1 = built first try; each repair round adds one. */
  buildRounds: number;
  costUsd: number;
}

const maxRepairRounds = 2;

export async function runRewrite(args: RewriteArgs, io: RewriteIo): Promise<RewriteResult> {
  const exec = io.exec ?? defaultExec;
  const runAgent = io.runAgent ?? defaultRunAgent;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const model = env.VENDO_DEMO_AGENT_MODEL ?? "sonnet";
  // Sonnet by default here too: the 45-min budget can't afford an opus pass
  // on the shell (a live run timed one out at 15 min), and the judge loop is
  // the quality backstop by design. Override for special runs.
  const shellModel = env.VENDO_DEMO_SHELL_MODEL ?? "sonnet";
  const researchDir = path.join(io.appDir, "RESEARCH");
  // Written by demo:create --notes; absent on runs without operator notes.
  const notesPath = path.join(researchDir, operatorNotesName);
  const operatorNotes = existsSync(notesPath) ? await readFile(notesPath, "utf8") : undefined;
  if (operatorNotes !== undefined) write(`[rewrite] operator notes: ${operatorNotes.split("\n").length} lines, authoritative over the invent-everything default`);

  // (a) Deterministic brand tokens.
  const report = await runStage("rewrite:tokens", async () => {
    const parsed = JSON.parse(await readFile(path.join(researchDir, "research.json"), "utf8")) as ResearchReport;
    const baseTheme = JSON.parse(await readFile(path.join(io.appDir, ".vendo", "theme.json"), "utf8")) as ThemeTokens;
    const derived = deriveThemeTokens(parsed, baseTheme);
    await writeFile(path.join(io.appDir, ".vendo", "theme.json"), `${JSON.stringify(derived.theme, null, 2)}\n`);

    let logoPath: string | undefined;
    const logoAsset = pickLogoAsset(parsed);
    if (logoAsset !== undefined) {
      logoPath = `public/brand/${path.basename(logoAsset)}`;
      await mkdir(path.join(io.appDir, "public", "brand"), { recursive: true });
      await cp(path.join(researchDir, logoAsset), path.join(io.appDir, logoPath));
    }
    await writeFile(
      path.join(researchDir, "BRAND.md"),
      renderBrandBrief({
        prospect: args.prospect,
        url: args.url,
        derived,
        report: parsed,
        ...(logoPath === undefined ? {} : { logoPath }),
        ...(operatorNotes === undefined ? {} : { operatorNotes }),
      }),
    );
    write(`[rewrite] theme tokens written (${derived.notes.length} notes), logo ${logoPath ?? "NOT FOUND — flagged in BRAND.md"}`);
    return parsed;
  });
  void report;

  // (b) Plan, then the parallel fan-out.
  const plan = await runStage("rewrite:plan", async () => {
    const result = await runAgent(
      {
        name: "plan",
        prompt: buildPlanPrompt({ prospect: args.prospect, url: args.url, ...(operatorNotes === undefined ? {} : { operatorNotes }) }),
        maxBudgetUsd: 3,
        timeoutMs: 8 * 60 * 1000,
        model,
      },
      { cwd: io.appDir, env, readOnly: true, ...(io.signal === undefined ? {} : { signal: io.signal }) },
    );
    if (result.code !== 0) throw new Error(`Plan agent failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}):\n${result.output.slice(0, 1000)}`);
    const parsedPlan = parseRewritePlan(result.output);
    await writeFile(path.join(researchDir, "PLAN.json"), `${JSON.stringify(parsedPlan, null, 2)}\n`);
    write(`[rewrite] plan: entity=${parsedPlan.entity.name}, screens=${parsedPlan.screens.map((screen) => screen.slug).join(",")} ($${result.costUsd?.toFixed(2) ?? "?"})`);
    return { plan: parsedPlan, planResult: result };
  });

  const fencedSnapshot = await snapshotFencedFiles(io.appDir);
  const agents: AgentRunResult[] = [plan.planResult];

  await runStage("rewrite:agents", async () => {
    const jobs = buildAgentJobs({
      prospect: args.prospect,
      plan: plan.plan,
      model,
      shellModel,
      ...(operatorNotes === undefined ? {} : { operatorNotes }),
    });
    write(`[rewrite] fan-out: ${jobs.map((job) => job.name).join(", ")} (parallel)`);
    const results = await Promise.all(jobs.map((job) => runAgent(job, { cwd: io.appDir, env, ...(io.signal === undefined ? {} : { signal: io.signal }) })));
    agents.push(...results);
    const failed = results.filter((result) => result.code !== 0);
    for (const result of results) {
      write(`[rewrite] agent ${result.name}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""} ($${result.costUsd?.toFixed(2) ?? "?"})`);
    }
    if (failed.length > 0) {
      throw new Error(`${failed.length} rewrite agent(s) failed: ${failed.map((result) => `${result.name} (exit ${result.code}${result.timedOut ? ", timed out" : ""})`).join(", ")}\nFirst failure output:\n${failed[0]?.output.slice(0, 1000)}`);
    }
  });

  // (c) Assembly.
  const { fencedViolations, buildRounds } = await runStage("rewrite:assembly", async () => {
    const violations = await verifyFencedFiles(io.appDir, fencedSnapshot);
    if (violations.length > 0) write(`[rewrite] FENCE VIOLATION restored: ${violations.join(", ")} (flagged, continuing with the restored plumbing)`);

    const configRaw = await readFile(path.join(io.appDir, "demo.config.json"), "utf8");
    if (hasCreatorTodos(configRaw)) throw new Error("demo.config.json still carries TODO(creator) fences after the beats agent — the rewrite is incomplete");
    const { parseDemoConfig } = await import("demo-template/demo-config");
    parseDemoConfig(JSON.parse(configRaw), `rewritten demo config at "${path.join(io.appDir, "demo.config.json")}"`);

    const buildStep = appBuildCommand({ repoRoot: io.repoRoot, appDir: io.appDir, packageName: args.packageName });
    let rounds = 0;
    for (;;) {
      rounds += 1;
      write(`[rewrite] build check (round ${rounds}): ${buildStep.command.join(" ")}`);
      const build = await exec(buildStep.command, { cwd: buildStep.cwd });
      if (build.code === 0) break;
      if (rounds > maxRepairRounds) {
        throw new Error(`Demo build still failing after ${maxRepairRounds} repair round(s):\n${(build.stderr || build.stdout).slice(-3000)}`);
      }
      const errorTail = (build.stderr || build.stdout).slice(-6000);
      write(`[rewrite] build failed — repair agent round ${rounds}`);
      const repair = await runAgent({
        name: `repair-${rounds}`,
        prompt: `You are the REPAIR agent for a ${args.prospect} demo built from the Vendo demo-template by several parallel agents. The build failed; fix it with the SMALLEST change that keeps the intent.

${sharedRules(args.prospect, operatorNotes)}

YOUR FILE LIST (writable): everything in this app EXCEPT the fenced files above and .vendo/theme.json.

Build error output (tail):
${errorTail}`,
        maxBudgetUsd: 6,
        timeoutMs: 12 * 60 * 1000,
        model,
      }, { cwd: io.appDir, env, ...(io.signal === undefined ? {} : { signal: io.signal }) });
      agents.push(repair);
      if (repair.code !== 0) throw new Error(`Repair agent failed (exit ${repair.code}):\n${repair.output.slice(0, 1000)}`);
      const repairViolations = await verifyFencedFiles(io.appDir, fencedSnapshot);
      if (repairViolations.length > 0) write(`[rewrite] FENCE VIOLATION restored after repair: ${repairViolations.join(", ")}`);
    }
    return { fencedViolations: violations, buildRounds: rounds };
  });

  const costUsd = agents.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  write(`[rewrite] done: ${agents.length} agent runs, ~$${costUsd.toFixed(2)}, build rounds ${buildRounds}`);
  return { plan: plan.plan, agents, fencedViolations, buildRounds, costUsd };
}
