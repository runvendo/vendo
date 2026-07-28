import path from "node:path";
import type { DemoBeat } from "demo-template/demo-config";
import { describe, expect, it } from "vitest";
import {
  beatVarietyProblems,
  demoPaths,
  normalizeHex,
  parseDemoFolderConfig,
  parseDemoTheme,
  requiredBeatKeys,
} from "./demo-folder.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const beat = (key: string, extra: Partial<DemoBeat> = {}): DemoBeat => ({
  key,
  chip: `${key} chip`,
  prompt: `${key} prompt`,
  ...extra,
});

/** The five-kind arc a generated demo must cover, with both expectation flags
 * where the contract puts them. */
const fullArc = (): DemoBeat[] => [
  beat("generate-ui", { expectsView: true }),
  beat("take-action", { expectsApproval: true }),
  beat("automation"),
  beat("connect-account"),
  beat("save-app"),
];

const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "northwind",
  prospect: "Northwind Freight",
  ctaUrl: "https://cal.com/vendo/northwind",
  beats: fullArc(),
  caps: { maxTurns: 20, maxSpendUsd: 5 },
  expiresAt: "2026-08-31T00:00:00Z",
  placement: { trigger: "header", slot: "beside the search field in the top bar" },
  ...overrides,
});

const theme = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  colors: {
    background: "#FFFFFF", surface: "#FBFBFA", text: "#0B1220", muted: "#908C85",
    accent: "#1E6BFF", accentText: "#FFFFFF", danger: "#B42318", border: "#ECEBE8",
  },
  typography: { fontFamily: "Söhne, sans-serif", baseSize: "15px" },
  radius: { small: "5px", medium: "10px", large: "15px" },
  density: "compact",
  motion: "full",
  ...overrides,
});

// ---------------------------------------------------------------------------

describe("demoPaths", () => {
  // The frozen demo-folder contract, as an assertion: every stage reads and
  // writes through here, so a silent move breaks the host's build-time manifest.
  it("puts every file exactly where the frozen contract says", () => {
    const paths = demoPaths("/repo", "acme");
    const root = path.join("/repo", "demos", "acme");
    expect(paths).toEqual({
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
      researchDir: path.join(root, "RESEARCH"),
      contextDevDir: path.join(root, "RESEARCH", "context-dev"),
      timings: path.join(root, "RESEARCH", "timings.json"),
    });
  });

  it("scopes every path under demos/<slug>/ so no stage can write outside it", () => {
    const paths = demoPaths("/repo", "acme");
    for (const value of Object.values(paths)) expect(value.startsWith(paths.root)).toBe(true);
  });
});

describe("beatVarietyProblems", () => {
  it("accepts the full five-kind arc", () => {
    expect(beatVarietyProblems(fullArc())).toEqual([]);
  });

  it("names each missing kind", () => {
    for (const key of requiredBeatKeys) {
      const problems = beatVarietyProblems(fullArc().filter((entry) => entry.key !== key));
      expect(problems.join("; ")).toContain(`missing beat(s): ${key}`);
    }
  });

  it("names every missing kind at once rather than only the first", () => {
    expect(beatVarietyProblems([beat("generate-ui", { expectsView: true })]))
      .toEqual(["missing beat(s): take-action, automation, connect-account, save-app"]);
  });

  // These two branches fail INDEPENDENTLY. Every other fixture in the suite
  // sets both flags, which left either check deletable with the suite green.
  it("rejects a generate-ui beat that does not declare expectsView, with take-action intact", () => {
    const beats = fullArc().map((entry) => (entry.key === "generate-ui" ? beat("generate-ui") : entry));
    expect(beatVarietyProblems(beats)).toEqual(['beat "generate-ui" must declare expectsView: true']);
  });

  it("rejects a take-action beat that does not declare expectsApproval, with generate-ui intact", () => {
    const beats = fullArc().map((entry) => (entry.key === "take-action" ? beat("take-action") : entry));
    expect(beatVarietyProblems(beats)).toEqual(['beat "take-action" must declare expectsApproval: true']);
  });

  it("does not accept the wrong flag on either beat", () => {
    const swapped = fullArc().map((entry) => {
      if (entry.key === "generate-ui") return beat("generate-ui", { expectsApproval: true });
      if (entry.key === "take-action") return beat("take-action", { expectsView: true });
      return entry;
    });
    expect(beatVarietyProblems(swapped)).toEqual([
      'beat "generate-ui" must declare expectsView: true',
      'beat "take-action" must declare expectsApproval: true',
    ]);
  });
});

describe("parseDemoFolderConfig", () => {
  it("accepts a valid config and keeps the placement alongside the base fields", async () => {
    const parsed = await parseDemoFolderConfig(config());
    expect(parsed.placement).toEqual({ trigger: "header", slot: "beside the search field in the top bar" });
    expect(parsed.id).toBe("northwind");
    expect(parsed.beats).toHaveLength(requiredBeatKeys.length);
  });

  // The base schema is .strict(): a stray field is a typo in a generated config,
  // and silently dropping it is how a beat's expectation goes missing.
  it("rejects a stray field the base schema does not know", async () => {
    await expect(parseDemoFolderConfig(config({ theme: "dark" })))
      .rejects.toThrow(/invalid demo config[\s\S]*theme/);
  });

  it("rejects a placement trigger that is neither header nor sidebar", async () => {
    await expect(parseDemoFolderConfig(config({ placement: { trigger: "floating", slot: "bottom right" } })))
      .rejects.toThrow(/placement\.trigger/);
  });

  it("rejects a missing placement and an empty slot", async () => {
    await expect(parseDemoFolderConfig(config({ placement: undefined }))).rejects.toThrow(/placement/);
    await expect(parseDemoFolderConfig(config({ placement: { trigger: "sidebar", slot: "  " } })))
      .rejects.toThrow(/placement\.slot/);
  });

  it("rejects an incomplete beat arc, labelled with the caller's source", async () => {
    await expect(parseDemoFolderConfig(config({ beats: [beat("generate-ui", { expectsView: true })] }), "demos/acme/demo.config.json"))
      .rejects.toThrow(/invalid demos\/acme\/demo\.config\.json[\s\S]*missing beat/);
  });

  it("rejects anything that is not a JSON object", async () => {
    await expect(parseDemoFolderConfig("{}")).rejects.toThrow(/must be a JSON object/);
    await expect(parseDemoFolderConfig(null)).rejects.toThrow(/must be a JSON object/);
  });
});

describe("parseDemoTheme", () => {
  it("accepts the demo-template theme shape verbatim", () => {
    expect(parseDemoTheme(theme()).colors.accent).toBe("#1E6BFF");
  });

  // Same schema the host validates with at build time, so a theme that would
  // fail there fails here instead.
  it("rejects a theme the host's own schema rejects, naming the field", () => {
    expect(() => parseDemoTheme(theme({ motion: "springy" }))).toThrow(/invalid theme\.json[\s\S]*motion/);
    expect(() => parseDemoTheme(theme({ density: "cozy" }))).toThrow(/density/);
    const { accent, ...missingAccent } = theme().colors as Record<string, string>;
    void accent;
    expect(() => parseDemoTheme(theme({ colors: missingAccent }))).toThrow(/colors\.accent/);
  });

  it("labels the error with the caller's source", () => {
    expect(() => parseDemoTheme({}, "demos/acme/theme.json")).toThrow(/invalid demos\/acme\/theme\.json/);
  });
});

describe("normalizeHex", () => {
  it("upper-cases a six-digit hex", () => {
    expect(normalizeHex("#1e6bff")).toBe("#1E6BFF");
    expect(normalizeHex("  #1E6BFF  ")).toBe("#1E6BFF");
  });

  it("expands shorthand", () => {
    expect(normalizeHex("#fff")).toBe("#FFFFFF");
    expect(normalizeHex("#0AB")).toBe("#00AABB");
  });

  // Undefined rather than a guess: an unparseable colour must fail the closed
  // palette check, never sneak into a theme as something plausible.
  it("returns undefined for anything that is not a hex", () => {
    for (const garbage of ["", "1E6BFF", "#12345", "#1234567", "rgb(1,2,3)", "#12345g", "blue"]) {
      expect(normalizeHex(garbage)).toBeUndefined();
    }
  });
});
