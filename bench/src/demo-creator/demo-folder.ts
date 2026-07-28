import type { Dirent } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { vendoThemeSchema, type VendoTheme } from "@vendoai/core";
import type { DemoBeat, DemoConfig } from "demo-template/demo-config";
import { maxChips } from "./chips.js";

/**
 * The demo folder contract, as code.
 *
 * One generated demo is a directory inside the vendo-demos host repo
 * (`demos/<slug>/`), and the host discovers it at BUILD time
 * (`host/scripts/gen-manifest.mjs` writes static imports). Every stage of
 * `demo:pipeline` reads and writes through {@link demoPaths} so the layout
 * lives in exactly one place — a stage that invents its own path is the bug
 * this module exists to prevent.
 */

export interface DemoPaths {
  /** demos/<slug>/ */
  root: string;
  screensDir: string;
  /** screens/index.tsx — default-exports the product page. */
  screensIndex: string;
  serverDir: string;
  entities: string;
  seed: string;
  routes: string;
  openapi: string;
  tools: string;
  config: string;
  theme: string;
  brandDir: string;
  logoSvg: string;
  logoPng: string;
  brief: string;
  researchDir: string;
  /** RESEARCH/context-dev/ — raw API responses, one file per call. */
  contextDevDir: string;
  /** RESEARCH/timings.json — per-stage wall clock for the run that built this. */
  timings: string;
}

/**
 * The only slug shape a demo may have.
 *
 * The slug reaches this process from a Slack message (the lane-3 driver passes
 * it straight through as `--id`) and every stage joins it onto a path, so it is
 * remotely-reachable path input. An allowlist, never a sanitiser: a rewritten
 * slug would silently build a demo at a folder nobody asked for, and the host's
 * URL is the slug too.
 */
export const demoSlugPattern = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Validates a slug, or throws naming the option it came from. */
export function parseDemoSlug(value: string, option = "--id"): string {
  if (!demoSlugPattern.test(value) || value.endsWith("-") || value !== path.basename(value)) {
    throw new Error(
      `${option}: "${value}" is not a valid demo slug — lowercase letters, digits and hyphens only, 2-41 characters, no leading or trailing hyphen, and one path segment (it is both a directory name under demos/ and the demo's public URL)`,
    );
  }
  return value;
}

/** Absolute paths for one demo inside a vendo-demos checkout. */
export function demoPaths(demosRepo: string, slug: string): DemoPaths {
  // Re-asserted here, not only at the CLI boundary: every stage builds its
  // paths through this function, so a slug that reached a stage some other way
  // (a config field, a future caller) still cannot escape demos/.
  const root = path.join(demosRepo, "demos", parseDemoSlug(slug));
  const researchDir = path.join(root, "RESEARCH");
  return {
    root,
    screensDir: path.join(root, "screens"),
    screensIndex: path.join(root, "screens", "index.tsx"),
    serverDir: path.join(root, "server"),
    entities: path.join(root, "server", "entities.ts"),
    seed: path.join(root, "server", "seed.ts"),
    routes: path.join(root, "server", "routes.ts"),
    openapi: path.join(root, "openapi.json"),
    tools: path.join(root, "tools.json"),
    config: path.join(root, "demo.config.json"),
    theme: path.join(root, "theme.json"),
    brandDir: path.join(root, "brand"),
    logoSvg: path.join(root, "brand", "logo.svg"),
    logoPng: path.join(root, "brand", "logo.png"),
    brief: path.join(root, "BRIEF.md"),
    researchDir,
    contextDevDir: path.join(researchDir, "context-dev"),
    timings: path.join(researchDir, "timings.json"),
  };
}

/**
 * Every symlink inside the demo folder, demo-folder-relative, with its target.
 *
 * Symlinked directories are NOT followed: the link itself is the finding, and
 * following one is how a walk over a link to `/` never returns.
 */
export async function findSymlinks(root: string): Promise<{ file: string; target: string }[]> {
  const found: { file: string; target: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A folder that does not exist yet holds no symlinks.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        found.push({ file: path.relative(root, full), target: await readlink(full).catch(() => "(unreadable)") });
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * A symlink in a generated demo folder is never legitimate, and it defeats
 * every path-shaped fence there is: the link lives INSIDE demos/<slug>/, so the
 * host fence sees nothing wrong, git commits it as mode 120000, and the host's
 * build step later reads through it — one planted `brand/logo.png ->
 * /etc/passwd` and the demo serves the file it points at.
 *
 * Asserted after every agent run and again before the commit. The host repo is
 * fixing the same class in its build step; both sides is correct here.
 */
export async function assertNoSymlinks(root: string, slug: string): Promise<void> {
  const links = await findSymlinks(root);
  if (links.length > 0) {
    throw new Error(
      `demos/${slug}/ contains symlink(s), which a generated demo never legitimately has: ${links.map((link) => `${link.file} -> ${link.target}`).join(", ")} — git would commit them as mode 120000 and the host would read through them. Delete them and re-run.`,
    );
  }
}

/** Where the host's build-time discovery script lives, relative to the
 * vendo-demos checkout root (frozen in the master contract). */
export const genManifestScript = "host/scripts/gen-manifest.mjs";

/** The host package inside the vendo-demos checkout. */
export const hostDir = "host";

// ---------------------------------------------------------------------------
// demo.config.json
// ---------------------------------------------------------------------------

/** Where `screens/index.tsx` mounts the Vendo trigger, and the slot the page
 * renders it into. The vision brief decides both; the host reads `trigger` to
 * pick the pre-wired kit component. */
export interface DemoPlacement {
  trigger: "header" | "sidebar";
  /** Free text describing where in screens/index.tsx the surface renders. */
  slot: string;
}

/**
 * The prospect's language, for the few strings that live in the HOST's chrome
 * rather than in the demo's own screens. A Spanish product whose assistant panel
 * answers in English fails the only bar these demos have, and the demo folder
 * cannot reach those strings — so the language travels in the config and the
 * host applies it. Absent means English.
 *
 * DISCLOSURE IS NOT TRANSLATABLE: there is deliberately no key for the
 * watermark, the CTA or the limit/expired card. They tell a viewer this is a
 * Vendo demo running on invented data, and {@link parseDemoStrings} rejects any
 * attempt to translate them — including one by a future generation agent.
 * Mirrors `host/src/lib/demo-strings.ts` in runvendo/vendo-demos.
 */
export interface DemoStrings {
  /** BCP-47 tag, applied as `lang` on the demo's root element. */
  locale?: string;
  /** The floating launcher pill. Default `Ask <prospect>`. */
  triggerLabel?: string;
  /** Empty generated-view slot: headline, subline, primary button. */
  slotTitle?: string;
  slotSubtitle?: string;
  slotCtaLabel?: string;
  /** The conversation's landing headline. */
  threadGreeting?: string;
}

/** demo.config.json = demo-template's schema EXTENDED with `placement` and
 * `strings`. The base schema is `.strict()`, so both are split off before it
 * parses. */
export interface DemoFolderConfig extends DemoConfig {
  placement: DemoPlacement;
  strings?: DemoStrings;
}

/**
 * The beat arc every generated demo must cover. Contract: variety is
 * required, so the keys are pinned rather than left to an agent's taste —
 * a demo missing the automation or connect-account beat is a demo that
 * never shows those capabilities to the prospect.
 */
export const requiredBeatKeys = ["generate-ui", "take-action", "automation", "connect-account", "save-app"] as const;
export type RequiredBeatKey = (typeof requiredBeatKeys)[number];

/** The one placement validator: the brief stage parses the model's reply with
 * it, and {@link parseDemoFolderConfig} parses what landed on disk. Two copies
 * with different error prose is two ways for the same bad value to read. */
export function parsePlacement(input: unknown): DemoPlacement {
  if (typeof input !== "object" || input === null) {
    throw new Error("placement: is required ({ trigger, slot })");
  }
  const { trigger, slot } = input as { trigger?: unknown; slot?: unknown };
  if (trigger !== "header" && trigger !== "sidebar") {
    throw new Error(`placement.trigger: must be "header" or "sidebar" (got ${JSON.stringify(trigger)})`);
  }
  if (typeof slot !== "string" || slot.trim() === "") {
    throw new Error("placement.slot: must be a non-empty description of where screens/index.tsx renders the surface");
  }
  return { trigger, slot };
}

/** The keys a demo may localise. Anything else in `strings` is a typo or an
 *  attempt to translate the disclosure chrome; both must fail loudly. */
const localisableKeys = ["locale", "triggerLabel", "slotTitle", "slotSubtitle", "slotCtaLabel", "threadGreeting"] as const;

/** BCP-47 subset — enough to catch "Spanish" or "es_MX" without pretending to
 *  validate the registry. */
const localePattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The one `strings` validator, for the same reason {@link parsePlacement} is
 *  the one placement validator. `undefined` in, `undefined` out: a demo with no
 *  strings block is an English demo, which is not an error. */
export function parseDemoStrings(input: unknown): DemoStrings | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) {
    throw new Error("strings: must be a JSON object of chrome string overrides");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!(localisableKeys as readonly string[]).includes(key)) {
      throw new Error(
        `strings.${key}: is not a localisable string (the watermark, CTA and limit card are disclosure and stay English) — expected one of ${localisableKeys.join(", ")}`,
      );
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`strings.${key}: must be a non-empty string (omit the key to keep the English default)`);
    }
  }
  const strings = Object.fromEntries(entries) as DemoStrings;
  if (strings.locale !== undefined && !localePattern.test(strings.locale)) {
    throw new Error(`strings.locale: must be a BCP-47 tag (e.g. "es", "es-419") — got ${JSON.stringify(strings.locale)}`);
  }
  return strings;
}

/**
 * Every structural rule the SHIPPED beat set must satisfy, in one place:
 *
 *  - all five kinds present (the arc the contract requires);
 *  - the two beats the smoke turn and the prospect's first click depend on carry
 *    their expectation flags;
 *  - keys are UNIQUE — merging copied authored beats verbatim, so a beats agent
 *    that wrote "automation" twice shipped two identical pills and every
 *    key-map lookup silently took the second;
 *  - at most {@link maxChips} beats — the length check only ever ran while
 *    APPENDING derived pills, so six authored beats sailed through;
 *  - `generate-ui` FIRST, because beats[0] is the prompt the smoke turn plays:
 *    a config that led with save-app left the view beat untested.
 *
 * Returns the problems rather than throwing so a caller can name them all at
 * once (build.ts hands the whole list to the repair agent).
 */
export function beatSetProblems(beats: readonly DemoBeat[]): string[] {
  const problems: string[] = [];
  const byKey = new Map(beats.map((beat) => [beat.key, beat]));
  const missing = requiredBeatKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) problems.push(`missing beat(s): ${missing.join(", ")}`);
  const duplicates = [...new Set(beats.map((beat) => beat.key).filter((key, index, keys) => keys.indexOf(key) !== index))];
  if (duplicates.length > 0) problems.push(`duplicate beat key(s): ${duplicates.join(", ")}`);
  if (beats.length > maxChips) problems.push(`too many beats: ${beats.length} (the chip strip shows at most ${maxChips})`);
  if (beats.length > 0 && beats[0]?.key !== "generate-ui") {
    problems.push(`beat "generate-ui" must come first (beats[0] is the smoke turn's prompt; got "${beats[0]?.key ?? ""}")`);
  }
  const generate = byKey.get("generate-ui");
  if (generate !== undefined && generate.expectsView !== true) {
    problems.push('beat "generate-ui" must declare expectsView: true');
  }
  const action = byKey.get("take-action");
  if (action !== undefined && action.expectsApproval !== true) {
    problems.push('beat "take-action" must declare expectsApproval: true');
  }
  return problems;
}

/**
 * Parses demos/<slug>/demo.config.json. `source` labels the error the way
 * demo-template's own parser does, so a malformed generated config fails with
 * one message naming every offending field.
 */
export async function parseDemoFolderConfig(input: unknown, source = "demo config"): Promise<DemoFolderConfig> {
  // Lazily imported for the same reason as everywhere else in this directory:
  // demo-template/demo-config resolves to TS source that node runs via type
  // stripping (>= 23.6), while bench's engines floor is >= 20.
  const { parseDemoConfig } = await import("demo-template/demo-config");
  if (typeof input !== "object" || input === null) throw new Error(`invalid ${source}: must be a JSON object`);
  const { placement, strings, ...base } = input as Record<string, unknown>;
  const config = parseDemoConfig(base, source);
  const problems = beatSetProblems(config.beats);
  if (problems.length > 0) throw new Error(`invalid ${source}: ${problems.join("; ")}`);
  try {
    const localised = parseDemoStrings(strings);
    return { ...config, placement: parsePlacement(placement), ...(localised === undefined ? {} : { strings: localised }) };
  } catch (error) {
    throw new Error(`invalid ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// theme.json
// ---------------------------------------------------------------------------

/** theme.json is the demo-template theme schema VERBATIM — the same object
 * `@vendoai/core`'s vendoThemeSchema validates, so a generated theme that the
 * host would reject at build time fails here instead. */
export type DemoTheme = VendoTheme;

export function parseDemoTheme(input: unknown, source = "theme.json"): DemoTheme {
  const result = vendoThemeSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ${source}: ${detail}`);
  }
  return result.data;
}

/** The token names the brief must assign a colour to. */
export const themeColorTokens = [
  "background", "surface", "text", "muted", "accent", "accentText", "danger", "border",
] as const;
export type ThemeColorToken = (typeof themeColorTokens)[number];

/**
 * The neutral ramp a brief may draw on when the brand evidence has no colour
 * for a structural token (page background, hairline border, muted label).
 * Brand hexes are always COPIED from evidence; these are the honest fallback
 * for roles a logo palette simply does not describe, and BRIEF.md records
 * which tokens fell back.
 */
export const neutralRamp = ["#FFFFFF", "#FBFBFA", "#F4F4F2", "#ECEBE8", "#908C85", "#3A3A38", "#111111", "#000000", "#B42318"] as const;

/** Hex normaliser: theme comparisons are case- and shorthand-insensitive. */
export function normalizeHex(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((character) => character + character).join("")}`.toUpperCase();
  }
  return undefined;
}
