import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  demoPaths,
  neutralRamp,
  normalizeHex,
  parseDemoTheme,
  parsePlacement,
  themeColorTokens,
  type DemoPlacement,
  type DemoTheme,
} from "./demo-folder.js";
import { readEvidence, type EvidenceResult } from "./evidence.js";
import { causeLine, defaultJudgeModel, extractJsonObject, type JudgeImage, type JudgeModelFn } from "./judge.js";

/**
 * Stage 2 — the brand brief. ONE vision call over the operator screenshots and
 * everything stage 1 harvested, producing the two files every later stage reads:
 * `theme.json` (the demo-template theme schema verbatim) and `BRIEF.md` (the
 * evidence digest each build agent reads first).
 *
 * The load-bearing rule (master contract): "hexes COPIED from evidence, vision
 * assigns roles only". A model asked for a colour will happily produce a
 * plausible-but-wrong one, and a demo whose accent is off by a hue is a demo the
 * prospect does not recognise. So this stage never asks for a colour — it hands
 * the model a NUMBERED, CLOSED palette (the real brand hexes plus the neutral
 * ramp for structural roles a logo palette cannot describe) and asks only which
 * role each hex plays. {@link parseBriefReply} rejects any hex outside that
 * list, so an invented colour is a parse failure, not a shipped mistake.
 *
 * Everything else that can be measured IS measured: font family, body size and
 * radius come off the styleguide, not the model's eye. The model's own calls are
 * limited to what only eyes can decide — density, motion, and the structural
 * reading of the screenshots.
 */

export interface BriefEntity {
  name: string;
  stem: string;
  action: string;
  fields: string[];
  sampleRecordNames: string[];
}

export interface BrandBrief {
  company: string;
  oneLiner: string;
  /** What the reference screenshot actually shows — the surface screens/index.tsx must clone 1:1. */
  productSurface: string;
  /** Which screenshot is the reference (RESEARCH-relative file name). */
  referenceScreenshot: string;
  nav: string[];
  vocabulary: string[];
  voice: string;
  entities: BriefEntity[];
  /** Raw material the beats agent turns into chips: things a real user would ask for. */
  chipMaterial: string[];
  placement: DemoPlacement;
  themeNotes: string[];
}

export interface BriefResult {
  theme: DemoTheme;
  brief: BrandBrief;
  themePath: string;
  briefPath: string;
  costUsd?: number;
}

export interface BriefArgs {
  slug: string;
  prospect: string;
  url?: string;
  notes?: string;
}

export interface BriefIo {
  demosRepo: string;
  model?: JudgeModelFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  evidence?: EvidenceResult;
}

// ---------------------------------------------------------------------------
// The closed palette
// ---------------------------------------------------------------------------

/**
 * The ONE ordered sequence of (hex, provenance) pairs the closed palette is
 * built from — deduped, first source wins.
 *
 * Ordering matters twice over. The prompt numbers this list and a model reaches
 * for the top of a list, which is exactly where the real brand colours belong;
 * and the label a token reports in BRIEF.md must name the source the palette
 * actually drew that hex from. Walking these six styleguide fields twice, in
 * two orders, was how the palette and the provenance could disagree — so both
 * {@link allowedPalette} and {@link paletteProvenance} derive from here.
 *
 * The specific styleguide roles lead: they are measured off the prospect's live
 * page (stage 1 folds the same three into `evidence.palette` in this order), so
 * they are both the most trustworthy hexes and the most informative labels.
 * They are also why the styleguide colours are here at all — without them the
 * model literally cannot pick the real accent when stage 1's colour call failed
 * soft but the styleguide call did not.
 */
function paletteSources(evidence: EvidenceResult, notes?: string): { hex: string; provenance: string }[] {
  const sources: { hex: string; provenance: string }[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined, provenance: string): void => {
    const hex = value === undefined ? undefined : normalizeHex(value);
    if (hex !== undefined && !seen.has(hex)) {
      seen.add(hex);
      sources.push({ hex, provenance });
    }
  };
  // FIRST, because the prompt promises it: operator notes outrank everything
  // below them, and the closed palette is below them. A prospect's in-product
  // palette is routinely NOT their marketing site's (a dark portal behind a
  // white .com), and context.dev can only measure the public page — so without
  // this the brief is told to obey the notes and then rejected for doing it.
  for (const value of notes?.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []) {
    add(value, "operator notes (pinned by the operator)");
  }
  const styleguide = evidence.styleguide;
  add(styleguide?.colors.accent, "brand evidence (styleguide accent)");
  add(styleguide?.colors.background, "brand evidence (styleguide background)");
  add(styleguide?.colors.text, "brand evidence (styleguide text)");
  add(styleguide?.components?.button?.primary?.backgroundColor, "brand evidence (styleguide primary button background)");
  add(styleguide?.components?.button?.primary?.color, "brand evidence (styleguide primary button text)");
  add(styleguide?.components?.card?.borderColor, "brand evidence (styleguide card border)");
  for (const value of evidence.palette) add(value, "brand evidence (context.dev brand palette)");
  for (const value of neutralRamp) add(value, "neutral ramp (no brand hex describes this role)");
  return sources;
}

/** Every hex the brief is allowed to assign, in the order the prompt numbers
 * them: real brand hexes first, then the neutral ramp. */
export function allowedPalette(evidence: EvidenceResult, notes?: string): string[] {
  return paletteSources(evidence, notes).map((source) => source.hex);
}

/** Human-readable source for each allowed hex, keyed and ordered exactly like
 * {@link allowedPalette} — BRIEF.md quotes these per token. */
export function paletteProvenance(evidence: EvidenceResult, notes?: string): Map<string, string> {
  return new Map(paletteSources(evidence, notes).map((source) => [source.hex, source.provenance]));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

const tokenRoles: Record<(typeof themeColorTokens)[number], string> = {
  background: "the page canvas behind everything",
  surface: "cards, panels and the Vendo sheet",
  text: "primary body and heading text",
  muted: "secondary labels, column headers, timestamps",
  accent: "the brand action colour — primary buttons, active nav, links",
  accentText: "text sitting ON the accent (must be legible against it)",
  danger: "destructive/error state",
  border: "hairlines between rows, cards and inputs",
};

/** How much of the scraped site copy reaches the prompt. Vocabulary and voice
 * come from the words the company actually uses, and a page of marketing prose
 * carries them; more than this is nav junk and repeated CTAs. */
export const siteTextBudget = 4_000;

export function buildBriefPrompt(options: {
  prospect: string;
  url?: string;
  evidence: EvidenceResult;
  palette: string[];
  notes?: string;
  /** The scraped site markdown (RESEARCH/site.md). Vocabulary/voice evidence. */
  siteText?: string;
}): string {
  const { prospect, url, evidence, palette, notes, siteText } = options;
  const provenance = paletteProvenance(evidence);
  const paletteList = palette
    .map((hex, index) => `${index + 1}. ${hex} — ${provenance.get(hex) ?? "allowed value"}`)
    .join("\n");
  const shots = evidence.screenshots
    .map((shot, index) => `- ${shot.file} (image ${index + 1}, from ${shot.source})`)
    .join("\n");
  const soft = evidence.soft.length === 0
    ? ""
    : `\nSome evidence gathering FAILED, so do not expect it: ${evidence.soft.map((entry) => `${entry.call} (${entry.reason})`).join("; ")}.\n`;
  return `You are writing the brand brief for a 1:1 mimic demo of ${prospect}${url === undefined ? "" : ` (${url})`}.

The images attached below are the REAL ${prospect} product UI, provided by an operator who has used it. They are the ground truth for what the demo must look like. Read them like an engineer about to rebuild the screen: regions, nav labels, column sets, header composition, density.
${notes === undefined ? "" : `
OPERATOR NOTES — AUTHORITATIVE. Established facts about this product, not suggestions. Where one contradicts anything below, the operator's note WINS:

${notes.trim()}
`}
Screenshots attached, in order:
${shots}
${evidence.markdown?.title === undefined ? "" : `\nTheir site's own title/tagline: ${evidence.markdown.title}\n`}${siteText === undefined || siteText.trim() === "" ? "" : `
Their own website copy (scraped) — the source for "vocabulary" and "voice". Use
THEIR words, not synonyms:

"""
${siteText.slice(0, siteTextBudget).trim()}
"""
`}${soft}
## Colours — you assign ROLES, you never invent a value

Below is the CLOSED list of hexes you may use. Every one was measured from
${prospect}'s real brand or is a neutral needed for a structural role. Assign each
theme token a value by copying an EXACT hex from this list. A hex that is not on
this list is rejected outright.

${paletteList}

Tokens to fill, and what each one paints:
${themeColorTokens.map((token) => `- "${token}": ${tokenRoles[token]}`).join("\n")}

Pick for FIDELITY, not taste: whatever the screenshots show as the action colour
is the accent even if you would not choose it. Keep accentText legible on accent.

## Reply

Output ONLY a JSON object (no prose, no markdown fence), exactly this shape:
{
  "company": "<the company name as they write it>",
  "oneLiner": "<one line: what the product does, in their words>",
  "productSurface": "<what the reference screenshot SHOWS, region by region — the thing that gets cloned 1:1>",
  "referenceScreenshot": "<the file name, copied exactly, of the screenshot that best shows the real product UI>",
  "nav": ["<their nav labels, exactly as they appear in the screenshot>"],
  "vocabulary": ["<the domain nouns/verbs their UI uses>"],
  "voice": "<one line on their register: formal/terse/playful, quirks>",
  "entities": [{
    "name": "<PascalCase core noun the screens list and act on, e.g. Load>",
    "stem": "<lowercase route/file slug, e.g. loads>",
    "action": "<the one consented mutation, camelCase, e.g. tenderLoad>",
    "fields": ["<name: type — meaning>"],
    "sampleRecordNames": ["<2-3 INVENTED but domain-plausible record names>"]
  }],
  "chipMaterial": ["<3-6 things a real ${prospect} user would ask for, imperative, in their vocabulary>"],
  "placement": {
    "trigger": "header" | "sidebar",
    "slot": "<where in the cloned screen the full-width generated-view PANEL renders, e.g. 'its own full-width row directly above the shipments table'>"
  },
  "colors": {
${themeColorTokens.map((token) => `    "${token}": { "hex": "<EXACT hex from the list>", "reason": "<one line>" }`).join(",\n")}
  },
  "density": "compact" | "comfortable",
  "motion": "full" | "reduced"
}

ALL record names and data are INVENTED — the evidence informs STYLE, never DATA.
Never reproduce a real customer, invoice or person from the screenshots.
"trigger" is "header" if their chrome is a top bar, "sidebar" if the primary nav
is a left rail. "slot" is a DIFFERENT surface from the trigger: the trigger is a
button, the slot is the panel a generated view renders into, so it needs a
content column — a row inside <main>, or a full-width band above a table or a
stat strip. Never place it in a control row (a top bar, a filter/date cluster, a
toolbar): those give it no width, and it is the panel, not the button, that goes
there. "density"/"motion" are your read of the screenshots.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** CSS generic keywords stay bare; anything that is not a plain ASCII word gets
 * quoted, so "Helvetica Neue" and "Söhne" survive as valid font-family stacks. */
const genericFamilies = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system",
]);

function cssFamily(name: string): string {
  const bare = name.trim().replace(/^["']+|["']+$/g, "").trim();
  if (genericFamilies.has(bare.toLowerCase())) return bare;
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(bare) ? bare : `"${bare}"`;
}

/** The template's neutral defaults — what a token keeps when the evidence says
 * nothing about it. Every fallback is named in themeNotes rather than hidden. */
const themeDefaults = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  baseSize: "15px",
  radius: { small: "6px", medium: "12px", large: "16px" },
} as const;

function firstPx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([\d.]+)\s*px/.exec(value.trim());
  const parsed = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function deriveTypography(evidence: EvidenceResult, notes: string[]): DemoTheme["typography"] {
  const body = evidence.styleguide?.typography?.p;
  const measured = evidence.fonts?.fonts[0]?.font ?? body?.fontFamily;
  // A styleguide fontFamily can arrive as a whole stack; the primary face is
  // its first segment.
  const primary = measured?.split(",")[0]?.trim();
  let fontFamily: string = themeDefaults.fontFamily;
  if (primary !== undefined && primary !== "") {
    const stack = [primary, ...(body?.fontFallbacks ?? []), "ui-sans-serif", "system-ui", "sans-serif"]
      .map((family) => cssFamily(family));
    fontFamily = [...new Set(stack)].join(", ");
    notes.push(`fontFamily: ${primary} — measured font evidence, with the evidence's own fallbacks appended`);
  } else {
    notes.push(`fontFamily: no font evidence — kept the demo-template default (${themeDefaults.fontFamily})`);
  }

  const baseSize = body?.fontSize;
  if (baseSize !== undefined && baseSize !== "") {
    notes.push(`baseSize: ${baseSize} — styleguide body text size`);
    return { fontFamily, baseSize };
  }
  notes.push(`baseSize: no body font-size in the evidence — kept the demo-template default ${themeDefaults.baseSize}`);
  return { fontFamily, baseSize: themeDefaults.baseSize };
}

function deriveRadius(evidence: EvidenceResult, notes: string[]): DemoTheme["radius"] {
  const components = evidence.styleguide?.components;
  const button = firstPx(components?.button?.primary?.borderRadius);
  const sampled = button ?? firstPx(components?.card?.borderRadius);
  if (sampled === undefined) {
    notes.push(`radius: no button or card radius in the evidence — kept the demo-template defaults (${themeDefaults.radius.small}/${themeDefaults.radius.medium}/${themeDefaults.radius.large})`);
    return { ...themeDefaults.radius };
  }
  // Same derivation the old mechanical transform used: clamp the measured
  // medium to a sane 2-24px (a "9999px" pill radius on a button must not become
  // the radius of every card), then hang small/large off it.
  const medium = Math.max(2, Math.min(24, Math.round(sampled)));
  notes.push(`radius: ${medium}px medium from the styleguide's ${button === undefined ? "card" : "primary button"} radius (${sampled}px raw, clamped 2-24)`);
  return {
    small: `${Math.max(2, Math.round(medium / 2))}px`,
    medium: `${medium}px`,
    large: `${Math.min(28, Math.round(medium * 1.5))}px`,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Brief output rejected: ${field} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value.trim();
}

function requireStrings(value: unknown, field: string): string[] {
  const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
  if (entries.length === 0) throw new Error(`Brief output rejected: ${field} must be a non-empty array of strings`);
  return entries.map((entry) => entry.trim());
}

function parseEntities(value: unknown): BriefEntity[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Brief output rejected: entities must list at least one domain entity");
  }
  return value.map((raw, index) => {
    const entity = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const label = `entities[${index}]`;
    const stem = requireString(entity["stem"], `${label}.stem`);
    if (!/^[a-z][a-z0-9-]*$/.test(stem)) {
      throw new Error(`Brief output rejected: ${label}.stem must be a lowercase slug (got ${JSON.stringify(stem)})`);
    }
    return {
      name: requireString(entity["name"], `${label}.name`),
      stem,
      action: requireString(entity["action"], `${label}.action`),
      fields: requireStrings(entity["fields"], `${label}.fields`),
      sampleRecordNames: requireStrings(entity["sampleRecordNames"], `${label}.sampleRecordNames`),
    };
  });
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Brief output rejected: ${field} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

export function parseBriefReply(
  raw: string,
  options: { prospect: string; palette: string[]; evidence: EvidenceResult; notes?: string },
): { theme: DemoTheme; brief: BrandBrief } {
  const parsed = extractJsonObject(raw, "Brief");
  const provenance = paletteProvenance(options.evidence, options.notes);
  const allowed = new Set(options.palette);

  const themeNotes: string[] = [];
  const colors = {} as DemoTheme["colors"];
  const rawColors = (typeof parsed["colors"] === "object" && parsed["colors"] !== null ? parsed["colors"] : {}) as Record<string, unknown>;
  for (const token of themeColorTokens) {
    const entry = (typeof rawColors[token] === "object" && rawColors[token] !== null ? rawColors[token] : {}) as Record<string, unknown>;
    const assigned = typeof entry["hex"] === "string" ? entry["hex"] : "";
    const hex = normalizeHex(assigned);
    // The whole point of the closed palette: an invented colour is a rejection,
    // never a shipped mistake. Naming the token AND the offending value is what
    // lets the caller reroll (and lets a live-run log say what went wrong).
    if (hex === undefined || !allowed.has(hex)) {
      throw new Error(`Brief output rejected: theme colour "${token}" is ${JSON.stringify(assigned)}, which is not in the evidence palette — the brief may only assign hexes it was given`);
    }
    colors[token] = hex;
    const reason = typeof entry["reason"] === "string" && entry["reason"].trim() !== "" ? entry["reason"].trim() : "(no reason given)";
    themeNotes.push(`${token}: ${hex} — ${provenance.get(hex) ?? "allowed value"} · ${reason}`);
  }

  const theme: DemoTheme = {
    colors,
    typography: deriveTypography(options.evidence, themeNotes),
    radius: deriveRadius(options.evidence, themeNotes),
    density: parseEnum(parsed["density"], ["compact", "comfortable"] as const, "density"),
    motion: parseEnum(parsed["motion"], ["full", "reduced"] as const, "motion"),
  };
  themeNotes.push(`density/motion: ${theme.density}/${theme.motion} — the vision call's read of the screenshots`);

  const referenceScreenshot = requireString(parsed["referenceScreenshot"], "referenceScreenshot");
  if (!options.evidence.screenshots.some((shot) => shot.file === referenceScreenshot)) {
    throw new Error(`Brief output rejected: referenceScreenshot ${JSON.stringify(referenceScreenshot)} is not one of the harvested screenshots (${options.evidence.screenshots.map((shot) => shot.file).join(", ") || "none"})`);
  }

  const brief: BrandBrief = {
    company: requireString(parsed["company"] ?? options.prospect, "company"),
    oneLiner: requireString(parsed["oneLiner"], "oneLiner"),
    productSurface: requireString(parsed["productSurface"], "productSurface"),
    referenceScreenshot,
    nav: requireStrings(parsed["nav"], "nav"),
    vocabulary: requireStrings(parsed["vocabulary"], "vocabulary"),
    voice: requireString(parsed["voice"], "voice"),
    entities: parseEntities(parsed["entities"]),
    chipMaterial: requireStrings(parsed["chipMaterial"], "chipMaterial"),
    placement: parsePlacement(parsed["placement"]),
    themeNotes,
  };
  return { theme, brief };
}

// ---------------------------------------------------------------------------
// BRIEF.md
// ---------------------------------------------------------------------------

/** BRIEF.md — deterministically rendered from the structured reply, never
 * model prose. Every build agent reads this file first, so a hallucinated
 * paragraph here would propagate into three agents at once. */
export function renderBriefMarkdown(
  brief: BrandBrief,
  options: { theme: DemoTheme; evidence: EvidenceResult; prospect: string; url?: string; notes?: string },
): string {
  const { theme, evidence, prospect, url, notes } = options;
  const reference = evidence.screenshots.find((shot) => shot.file === brief.referenceScreenshot);
  const others = evidence.screenshots.filter((shot) => shot.file !== brief.referenceScreenshot);
  const evidenceLines = [
    ...(reference === undefined ? [] : [`- RESEARCH/${reference.file} — **THE REFERENCE SCREEN.** screens/index.tsx is a structural 1:1 clone of this image.`]),
    ...others.map((shot) => `- RESEARCH/${shot.file} — supporting product UI (${shot.source})`),
    ...(evidence.markdown === undefined ? [] : [`- RESEARCH/${evidence.markdown.file} — their site copy${evidence.markdown.title === undefined ? "" : ` ("${evidence.markdown.title}")`}`]),
    ...evidence.rawFiles.map((file) => `- RESEARCH/${file} — raw context.dev response`),
  ].join("\n");

  return `# BRAND BRIEF — ${prospect}

${url === undefined ? "" : `Prospect site: ${url}\n`}ALL seed data is invented. The evidence informs STYLE, never DATA — never reproduce a
real customer, person, invoice or amount from the screenshots.
${notes === undefined || notes.trim() === "" ? "" : `
## OPERATOR NOTES — AUTHORITATIVE, they win every conflict

The operator has already used this product. Everything below is established
fact, not a suggestion: follow it literally, and where it contradicts any rule
in this brief (including "all seed data is invented") the operator's note WINS.
Anything the notes do not cover still follows the normal rules.

${notes.trim()}
`}
## Company

- ${brief.company} — ${brief.oneLiner}

## Product surface — clone this 1:1

${brief.productSurface}

Reference screenshot: RESEARCH/${brief.referenceScreenshot}
Nav labels, exactly as the product writes them: ${brief.nav.join(" · ")}

## Vocabulary

${brief.vocabulary.map((word) => `- ${word}`).join("\n")}

## Voice

${brief.voice}

## Entities and example records

${brief.entities.map((entity) => `### ${entity.name} (server/${entity.stem}, mutation \`${entity.action}\`)

Fields:
${entity.fields.map((field) => `- ${field}`).join("\n")}

Example records (INVENTED — use these or more like them):
${entity.sampleRecordNames.map((name) => `- ${name}`).join("\n")}`).join("\n\n")}

## Chip material

Raw material for demo.config.json's beats — what a real ${prospect} user would ask for:

${brief.chipMaterial.map((line) => `- ${line}`).join("\n")}

## Vendo placement

- trigger: \`${brief.placement.trigger}\`
- slot: ${brief.placement.slot}

screens/index.tsx mounts the Vendo kit's ${brief.placement.trigger} trigger there. Surfaces
come from host/src/vendo-kit only — never re-implement them.

## Applied theme tokens (theme.json — ALREADY WRITTEN, do not edit it)

${brief.themeNotes.map((note) => `- ${note}`).join("\n")}

Resolved: font \`${theme.typography.fontFamily}\` at ${theme.typography.baseSize}, radius ${theme.radius.small}/${theme.radius.medium}/${theme.radius.large}, ${theme.density} density, ${theme.motion} motion.

## Logo

${evidence.logo === undefined
    ? `- **NO usable logo was harvested.** Read the real wordmark off the reference screenshot and recreate the header wordmark faithfully in code (type, weight, letter-spacing, colour). NEVER a generic placeholder.`
    : `- Real logo at ${evidence.logo.file} (${evidence.logo.source}) — render it in the ${brief.placement.trigger} exactly where ${prospect} puts theirs.`}

## Fonts

- Primary face in evidence: ${evidence.fonts?.fonts[0]?.font ?? "(none measured)"}
- Use the REAL font when it is freely loadable (Google Fonts, other open source); NEVER ship a licensed font file — substitute the closest freely-available metric match and say so in a comment.

## Evidence — LOOK at every image, the reference screen first

${evidenceLines}

## Soft failures in evidence gathering

${evidence.soft.length === 0
    ? "- none — every evidence call succeeded."
    : evidence.soft.map((entry) => `- ${entry.call}: ${entry.reason} — work without it; do not invent what it would have told you.`).join("\n")}
`;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export async function runBrief(args: BriefArgs, io: BriefIo): Promise<BriefResult> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  if (io.model === undefined && !env.ANTHROPIC_API_KEY) {
    // Same posture chips.ts documents: the creator harness is provider-bound
    // end to end, so an operator holding only a Cloud key learns it here rather
    // than from an SDK 401 halfway through a $9 run.
    throw new Error(
      "demo:pipeline's brief stage needs ANTHROPIC_API_KEY — the demo-creator harness runs on a provider key "
      + "(so do the judge and the build agents), even though the demo it generates runs on VENDO_API_KEY.",
    );
  }
  // The vision seam is the judge's, verbatim: same 30s/60s/120s backoff, same
  // sonnet tier fallback, same VENDO_DEMO_JUDGE_MODEL override. One overload
  // burst must not kill a brief either, and one implementation is enough.
  const model = io.model ?? defaultJudgeModel;
  const paths = demoPaths(io.demosRepo, args.slug);
  // The pipeline hands the brief the evidence stage 1 just gathered; only the
  // standalone/`demo:fix` path re-reads RESEARCH/evidence.json from disk.
  const evidence = io.evidence ?? await readEvidence(io.demosRepo, args.slug);

  const palette = allowedPalette(evidence, args.notes);
  // The scraped site copy is stage 1 evidence too, and it is the only source
  // for vocabulary and voice — screenshots show structure, not register. A
  // missing/unreadable file is not worth failing a run over.
  const siteText = evidence.markdown === undefined
    ? undefined
    : await readFile(path.join(paths.researchDir, evidence.markdown.file), "utf8").catch(() => undefined);
  const prompt = buildBriefPrompt({
    prospect: args.prospect,
    evidence,
    palette,
    ...(args.url === undefined ? {} : { url: args.url }),
    ...(args.notes === undefined ? {} : { notes: args.notes }),
    ...(siteText === undefined ? {} : { siteText }),
  });
  const images: JudgeImage[] = evidence.screenshots.map((shot, index) => ({
    label: `EVIDENCE image ${index + 1} — the REAL ${args.prospect} product UI (${shot.file})`,
    path: path.join(paths.researchDir, shot.file),
  }));
  // SVG only: the vision API cannot read vector markup, and attaching it wastes
  // a slot and confuses the model. A png logo is a real extra look at the mark.
  if (evidence.logo !== undefined && evidence.logo.file.toLowerCase().endsWith(".png")) {
    images.push({ label: `EVIDENCE — ${args.prospect}'s real logo (${evidence.logo.file})`, path: path.join(paths.root, evidence.logo.file) });
  }

  const parseOptions = { prospect: args.prospect, palette, evidence, ...(args.notes === undefined ? {} : { notes: args.notes }) };
  let parsed: { theme: DemoTheme; brief: BrandBrief };
  try {
    parsed = parseBriefReply(await model(prompt, images), parseOptions);
  } catch (error) {
    // One reroll, the judge's lesson: a rejected sample is usually a one-off
    // glitch, and a fresh sample is far cheaper than losing the run.
    write(`[brief] reply rejected (${causeLine(error)}) — rerolling once`);
    try {
      parsed = parseBriefReply(await model(prompt, images), parseOptions);
    } catch (second) {
      // Say that the reroll already happened: unprefixed, this reads as a
      // first-try failure and an operator debugs a flake that got its retry.
      // The message is carried WHOLE, not first-lined — for a malformed reply
      // its tail is the raw reply, which is the only debuggable part.
      throw new Error(`brief: the reroll was rejected too — ${second instanceof Error ? second.message : String(second)}`);
    }
  }

  // Validate through the demo-template schema BEFORE it hits disk: a theme the
  // host would reject at build time must fail here instead.
  const theme = parseDemoTheme(parsed.theme);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.theme, `${JSON.stringify(theme, null, 2)}\n`);
  await writeFile(paths.brief, renderBriefMarkdown(parsed.brief, {
    theme,
    evidence,
    prospect: args.prospect,
    ...(args.url === undefined ? {} : { url: args.url }),
    ...(args.notes === undefined ? {} : { notes: args.notes }),
  }));
  write(`[brief] ${parsed.brief.company}: ${theme.colors.accent} accent, ${brandTokenCount(parsed.brief)} of ${themeColorTokens.length} tokens from brand evidence, placement ${parsed.brief.placement.trigger}`);
  return { theme, brief: parsed.brief, themePath: paths.theme, briefPath: paths.brief };
}

/** How many colour tokens landed on a real brand hex rather than the ramp —
 * the one number that says whether this demo will look like the prospect. */
function brandTokenCount(brief: BrandBrief): number {
  return brief.themeNotes.filter((note) => note.includes("brand evidence (")).length;
}
