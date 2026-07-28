import path from "node:path";
import { vendoThemeSchema, type VendoTheme } from "@vendoai/core";
import type { DemoBeat, DemoConfig } from "demo-template/demo-config";

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

/** Absolute paths for one demo inside a vendo-demos checkout. */
export function demoPaths(demosRepo: string, slug: string): DemoPaths {
  const root = path.join(demosRepo, "demos", slug);
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

/** demo.config.json = demo-template's schema EXTENDED with `placement`. The
 * base schema is `.strict()`, so `placement` is split off before it parses. */
export interface DemoFolderConfig extends DemoConfig {
  placement: DemoPlacement;
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

/**
 * Validates the arc: all five kinds present, and the two beats the smoke turn
 * and the prospect's first click depend on carry their expectation flags.
 * Returns the offending problems rather than throwing so callers can name them
 * all at once.
 */
export function beatVarietyProblems(beats: readonly DemoBeat[]): string[] {
  const problems: string[] = [];
  const byKey = new Map(beats.map((beat) => [beat.key, beat]));
  const missing = requiredBeatKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) problems.push(`missing beat(s): ${missing.join(", ")}`);
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
  const { placement, ...base } = input as Record<string, unknown>;
  const config = parseDemoConfig(base, source);
  const problems = beatVarietyProblems(config.beats);
  if (problems.length > 0) throw new Error(`invalid ${source}: ${problems.join("; ")}`);
  try {
    return { ...config, placement: parsePlacement(placement) };
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
