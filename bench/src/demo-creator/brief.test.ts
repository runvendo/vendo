import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedPalette,
  buildBriefPrompt,
  paletteProvenance,
  parseBriefReply,
  renderBriefMarkdown,
  runBrief,
  siteTextBudget,
} from "./brief.js";
import { demoPaths, neutralRamp, parseDemoTheme } from "./demo-folder.js";
import type { FontsResult, StyleguideResult } from "./context-dev.js";
import type { EvidenceResult } from "./evidence.js";

// ---------------------------------------------------------------------------
// Fixtures — stage 1's output, built by hand so no stage 1 runs here.
// ---------------------------------------------------------------------------

const styleguide: StyleguideResult = {
  colors: { accent: "#1E6BFF", background: "#FFFFFF", text: "#0B1220" },
  typography: {
    headings: {
      h1: { fontFamily: "Söhne", fontFallbacks: ["Helvetica Neue"], fontSize: "32px", fontWeight: "600", lineHeight: "38px", letterSpacing: "-0.01em" },
    },
    p: { fontFamily: "Söhne", fontFallbacks: ["Helvetica Neue", "Arial"], fontSize: "15px", fontWeight: "400", lineHeight: "24px", letterSpacing: "0px" },
  },
  elementSpacing: { md: "16px" },
  shadows: { sm: "0 1px 2px rgba(0,0,0,0.06)" },
  fontLinks: {},
  components: {
    button: { primary: { borderRadius: "10px", backgroundColor: "#1E6BFF", color: "#FFFFFF" } },
    card: { borderRadius: "16px", borderColor: "#E4E7EC" },
  },
};

const fonts: FontsResult = {
  fonts: [{ font: "Söhne", uses: ["p", "h1"], fallbacks: ["Helvetica Neue"], percent_elements: 82, percent_words: 91 }],
  fontLinks: {},
};

function evidence(overrides: Partial<EvidenceResult> = {}): EvidenceResult {
  return {
    screenshots: [
      { file: "operator-1.png", source: "operator" },
      { file: "operator-2.png", source: "operator" },
    ],
    logo: { file: "brand/logo.svg", source: "context.dev Retrieve Brand" },
    styleguide,
    fonts,
    markdown: { file: "site.md", title: "Northwind Freight — move more loads" },
    palette: ["#1e6bff", "#0B1220", "#E4E7EC"],
    soft: [],
    rawFiles: ["context-dev/brand.json", "context-dev/colors.json"],
    ...overrides,
  };
}

/** A well-formed model reply; `overrides` swap one top-level field per test. */
function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    company: "Northwind Freight",
    oneLiner: "Freight brokerage operations in one board",
    productSurface: "A loads board: left sidebar nav, a top bar with search, and a dense table of loads with status pills",
    referenceScreenshot: "operator-1.png",
    nav: ["Loads", "Carriers", "Invoices"],
    vocabulary: ["load", "carrier", "lane", "bill of lading"],
    voice: "Terse operational shorthand — nouns over sentences",
    entities: [{
      name: "Load",
      stem: "loads",
      action: "tenderLoad",
      fields: ["reference: string — the load number"],
      sampleRecordNames: ["LD-4471 Chicago to Dallas"],
    }],
    chipMaterial: ["Show me every load past its ETA"],
    placement: { trigger: "header", slot: "beside the search field in the top bar" },
    colors: {
      background: { hex: "#FFFFFF", reason: "page canvas is white" },
      surface: { hex: "#FBFBFA", reason: "cards sit slightly off-white" },
      text: { hex: "#0b1220", reason: "styleguide body text" },
      muted: { hex: "#908C85", reason: "secondary column labels" },
      accent: { hex: "#1E6BFF", reason: "primary button blue" },
      accentText: { hex: "#FFFFFF", reason: "white label on the blue button" },
      danger: { hex: "#B42318", reason: "no brand red in the evidence" },
      border: { hex: "#ECEBE8", reason: "hairline table rules" },
    },
    density: "compact",
    motion: "full",
    ...overrides,
  });
}

const parseOptions = (over: Partial<EvidenceResult> = {}) => {
  const result = evidence(over);
  return { prospect: "Northwind Freight", palette: allowedPalette(result), evidence: result };
};

// ---------------------------------------------------------------------------

describe("allowedPalette", () => {
  it("normalises the brand hexes, keeps them ahead of the ramp-only neutrals, and dedupes", () => {
    const palette = allowedPalette(evidence());
    expect(palette.slice(0, 4)).toEqual(["#1E6BFF", "#FFFFFF", "#0B1220", "#E4E7EC"]);
    for (const neutral of neutralRamp) expect(palette).toContain(neutral);
    expect(new Set(palette).size).toBe(palette.length);
  });

  it("carries the styleguide colours even when stage 1 did not fold them into palette", () => {
    const palette = allowedPalette(evidence({ palette: [] }));
    expect(palette).toContain("#1E6BFF");
    expect(palette).toContain("#0B1220");
  });

  // These were two separate walks over the SAME six styleguide colour fields,
  // in different orders: the provenance a token reported could name a source
  // the numbered palette had ranked somewhere else entirely. One sequence, one
  // dedupe, or they drift again.
  it("derives the palette order and the provenance map from ONE sequence", () => {
    const result = evidence();
    expect([...paletteProvenance(result).keys()]).toEqual(allowedPalette(result));
  });

  it("labels each hex with the first source that produced it, specific styleguide roles first", () => {
    const provenance = paletteProvenance(evidence());
    expect(provenance.get("#1E6BFF")).toContain("styleguide accent");
    expect(provenance.get("#E4E7EC")).toContain("card border");
    expect(provenance.get("#B42318")).toContain("neutral ramp");
  });
});

describe("buildBriefPrompt", () => {
  it("gives the model a numbered closed palette and forbids inventing a hex", () => {
    const result = evidence();
    const prompt = buildBriefPrompt({ prospect: "Northwind Freight", url: "https://northwind.example", evidence: result, palette: allowedPalette(result) });
    expect(prompt).toMatch(/1\. #1E6BFF/);
    expect(prompt).toMatch(/EXACT/);
    expect(prompt).toContain("operator-1.png");
    for (const token of ["background", "surface", "text", "muted", "accent", "accentText", "danger", "border"]) {
      expect(prompt).toContain(`"${token}"`);
    }
  });

  it("feeds the scraped site copy in as the source for vocabulary and voice", () => {
    // Screenshots show structure; only the company's own words show register.
    const result = evidence();
    const siteText = "Tender a load in one click. Every carrier, every lane, one board.";
    const prompt = buildBriefPrompt({ prospect: "Northwind Freight", evidence: result, palette: allowedPalette(result), siteText });
    expect(prompt).toContain(siteText);
    expect(prompt).toMatch(/vocabulary[\s\S]*voice/i);
  });

  it("truncates the site copy to the budget so nav junk cannot crowd out the images", () => {
    const result = evidence();
    const prompt = buildBriefPrompt({
      prospect: "Northwind Freight",
      evidence: result,
      palette: allowedPalette(result),
      siteText: `${"lane ".repeat(2_000)}TAIL_MARKER`,
    });
    expect(prompt).not.toContain("TAIL_MARKER");
    expect(prompt.length).toBeLessThan(siteTextBudget + 6_000);
  });

  it("says nothing about site copy when the scrape failed soft", () => {
    const result = evidence({ markdown: undefined });
    const prompt = buildBriefPrompt({ prospect: "Northwind Freight", evidence: result, palette: allowedPalette(result) });
    expect(prompt).not.toContain("website copy (scraped)");
  });
});

describe("parseBriefReply colours", () => {
  it("rejects a token whose hex is not in the allowed palette, naming the token and the value", () => {
    const bad = reply({
      colors: JSON.parse(reply()).colors as Record<string, unknown>,
    });
    const withInvented = JSON.parse(bad) as { colors: Record<string, { hex: string }> };
    withInvented.colors["accent"] = { hex: "#FF00AA", reason: "felt right" };
    expect(() => parseBriefReply(JSON.stringify(withInvented), parseOptions()))
      .toThrow(/accent[\s\S]*#FF00AA/);
  });

  it("accepts a shorthand hex that normalises into the palette", () => {
    const parsed = JSON.parse(reply()) as { colors: Record<string, { hex: string; reason: string }> };
    parsed.colors["surface"] = { hex: "#fff", reason: "white card" };
    const { theme } = parseBriefReply(JSON.stringify(parsed), parseOptions());
    expect(theme.colors.surface).toBe("#FFFFFF");
  });

  it("produces a theme parseDemoTheme accepts, with the model's density and motion", () => {
    const { theme } = parseBriefReply(reply(), parseOptions());
    expect(() => parseDemoTheme(theme)).not.toThrow();
    expect(theme.colors.accent).toBe("#1E6BFF");
    expect(theme.density).toBe("compact");
    expect(theme.motion).toBe("full");
  });

  it("records per-token provenance: brand evidence vs neutral ramp, with the evidence field", () => {
    const { brief } = parseBriefReply(reply(), parseOptions());
    expect(brief.themeNotes.find((note) => note.startsWith("accent:")))
      .toMatch(/#1E6BFF.*brand evidence.*styleguide accent/);
    expect(brief.themeNotes.find((note) => note.startsWith("danger:")))
      .toMatch(/#B42318.*neutral ramp/);
  });
});

describe("parseBriefReply non-colour tokens", () => {
  it("builds fontFamily from the real font evidence with the evidence fallbacks appended", () => {
    const { theme, brief } = parseBriefReply(reply(), parseOptions());
    expect(theme.typography.fontFamily).toBe('"Söhne", "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif');
    expect(brief.themeNotes.some((note) => note.startsWith("fontFamily: ") && note.includes("Söhne"))).toBe(true);
  });

  it("takes baseSize from the styleguide body font size", () => {
    const { theme } = parseBriefReply(reply(), parseOptions());
    expect(theme.typography.baseSize).toBe("15px");
  });

  it("derives the radius ramp from the primary button radius", () => {
    const { theme, brief } = parseBriefReply(reply(), parseOptions());
    expect(theme.radius).toEqual({ small: "5px", medium: "10px", large: "15px" });
    expect(brief.themeNotes.some((note) => note.startsWith("radius: ") && note.includes("button"))).toBe(true);
  });

  it("clamps a huge button radius to 24px medium and falls back to the card radius", () => {
    const pill: StyleguideResult = { ...styleguide, components: { ...styleguide.components, button: { primary: { borderRadius: "9999px" } } } };
    const clamped = parseBriefReply(reply(), parseOptions({ styleguide: pill }));
    expect(clamped.theme.radius).toEqual({ small: "12px", medium: "24px", large: "28px" });

    const cardOnly: StyleguideResult = { ...styleguide, components: { card: { borderRadius: "16px", borderColor: "#E4E7EC" } } };
    const fromCard = parseBriefReply(reply(), parseOptions({ styleguide: cardOnly }));
    expect(fromCard.theme.radius.medium).toBe("16px");
    expect(fromCard.brief.themeNotes.some((note) => note.includes("card"))).toBe(true);
  });

  it("keeps documented defaults and says so when there is no styleguide at all", () => {
    const options = parseOptions({ styleguide: undefined, fonts: undefined, palette: ["#1E6BFF", "#0B1220"] });
    const { theme, brief } = parseBriefReply(reply(), options);
    expect(() => parseDemoTheme(theme)).not.toThrow();
    expect(theme.colors.accent).toBe("#1E6BFF");
    expect(theme.typography.fontFamily).toBe("system-ui, -apple-system, Segoe UI, Roboto, sans-serif");
    expect(theme.typography.baseSize).toBe("15px");
    expect(theme.radius).toEqual({ small: "6px", medium: "12px", large: "16px" });
    expect(brief.themeNotes.some((note) => note.startsWith("fontFamily: ") && note.includes("no font evidence"))).toBe(true);
    expect(brief.themeNotes.some((note) => note.startsWith("radius: ") && note.includes("no "))).toBe(true);
    expect(brief.themeNotes.some((note) => note.startsWith("baseSize: ") && note.includes("no "))).toBe(true);
  });
});

describe("parseBriefReply structure", () => {
  it("keeps the placement the model chose", () => {
    const { brief } = parseBriefReply(reply(), parseOptions());
    expect(brief.placement).toEqual({ trigger: "header", slot: "beside the search field in the top bar" });
  });

  it("rejects a placement trigger that is neither header nor sidebar", () => {
    expect(() => parseBriefReply(reply({ placement: { trigger: "floating", slot: "bottom right" } }), parseOptions()))
      .toThrow(/placement\.trigger/);
  });

  it("rejects a reference screenshot that is not one of the harvested screenshots", () => {
    expect(() => parseBriefReply(reply({ referenceScreenshot: "made-up.png" }), parseOptions()))
      .toThrow(/referenceScreenshot/);
  });

  it("rejects an entity without a lowercase stem", () => {
    const entities = [{ name: "Load", stem: "Loads", action: "tenderLoad", fields: ["a: b"], sampleRecordNames: ["x"] }];
    expect(() => parseBriefReply(reply({ entities }), parseOptions())).toThrow(/stem/);
  });
});

describe("renderBriefMarkdown", () => {
  const render = (over: Partial<EvidenceResult> = {}, notes?: string) => {
    const options = parseOptions(over);
    const { theme, brief } = parseBriefReply(reply(), options);
    return renderBriefMarkdown(brief, {
      theme,
      evidence: options.evidence,
      prospect: "Northwind Freight",
      url: "https://northwind.example",
      ...(notes === undefined ? {} : { notes }),
    });
  };

  it("carries every section the contract requires", () => {
    const markdown = render();
    for (const heading of [
      "## Company",
      "## Product surface",
      "## Vocabulary",
      "## Voice",
      "## Entities",
      "## Chip material",
      "## Vendo placement",
      "## Applied theme tokens",
      "## Logo",
      "## Fonts",
      "## Evidence",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("Northwind Freight");
    expect(markdown).toContain("LD-4471 Chicago to Dallas");
    expect(markdown).toContain("tenderLoad");
    expect(markdown).toContain("beside the search field in the top bar");
  });

  it("states the invented-data invariant", () => {
    expect(render()).toMatch(/ALL seed data is invented[\s\S]*evidence informs STYLE, never DATA/i);
  });

  it("names the reference screenshot first in the evidence list", () => {
    const markdown = render();
    const reference = markdown.indexOf("operator-1.png");
    const other = markdown.indexOf("operator-2.png");
    expect(reference).toBeGreaterThan(-1);
    expect(reference).toBeLessThan(other);
  });

  it("spells out every stage-1 soft failure", () => {
    const markdown = render({ soft: [{ call: "Website Fonts", reason: "context.dev returned 502" }] });
    expect(markdown).toContain("## Soft failures");
    expect(markdown).toContain("Website Fonts");
    expect(markdown).toContain("context.dev returned 502");
  });

  it("says the harvest was clean when nothing failed soft", () => {
    expect(render()).toMatch(/## Soft failures[\s\S]*none/i);
  });

  it("shouts when no logo was harvested so the wordmark gets recreated in code", () => {
    const markdown = render({ logo: undefined });
    expect(markdown).toMatch(/NO usable logo[\s\S]*recreate/i);
  });

  it("puts operator notes in an authoritative section that wins every conflict", () => {
    const markdown = render({}, "Their nav says Dispatch, not Loads.");
    expect(markdown).toMatch(/## OPERATOR NOTES — AUTHORITATIVE/);
    expect(markdown).toMatch(/WINS/);
    expect(markdown).toContain("Their nav says Dispatch, not Loads.");
  });
});

describe("runBrief", () => {
  async function fixture(): Promise<{ demosRepo: string; slug: string }> {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-brief-"));
    const paths = demoPaths(demosRepo, "northwind");
    await mkdir(paths.researchDir, { recursive: true });
    await mkdir(paths.brandDir, { recursive: true });
    await writeFile(path.join(paths.researchDir, "operator-1.png"), "png-1");
    await writeFile(path.join(paths.researchDir, "operator-2.png"), "png-2");
    return { demosRepo, slug: "northwind" };
  }

  it("makes ONE model call and writes a validated theme.json plus BRIEF.md", async () => {
    const { demosRepo, slug } = await fixture();
    let calls = 0;
    const result = await runBrief({ slug, prospect: "Northwind Freight", url: "https://northwind.example" }, {
      demosRepo,
      evidence: evidence(),
      write: () => undefined,
      model: async () => { calls += 1; return reply(); },
    });
    expect(calls).toBe(1);
    const paths = demoPaths(demosRepo, slug);
    expect(result.themePath).toBe(paths.theme);
    expect(result.briefPath).toBe(paths.brief);
    const written = JSON.parse(await readFile(paths.theme, "utf8")) as unknown;
    expect(() => parseDemoTheme(written)).not.toThrow();
    expect(written).toEqual(result.theme);
    await expect(readFile(paths.brief, "utf8")).resolves.toContain("## Applied theme tokens");
  });

  it("shows the model the operator screenshots as the real product UI", async () => {
    const { demosRepo, slug } = await fixture();
    let labels: string[] = [];
    await runBrief({ slug, prospect: "Northwind Freight" }, {
      demosRepo,
      evidence: evidence(),
      write: () => undefined,
      model: async (_prompt, images) => { labels = images.map((image) => `${image.label} @ ${image.path}`); return reply(); },
    });
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/operator-1\.png/);
    expect(labels[0]).toMatch(/REAL Northwind Freight product UI/);
    expect(labels[0]).toContain(demoPaths(demosRepo, slug).researchDir);
  });

  it("attaches a png logo and skips an svg one the vision API cannot read", async () => {
    const { demosRepo, slug } = await fixture();
    const paths = demoPaths(demosRepo, slug);
    await writeFile(paths.logoPng, "png-logo");
    const seen = async (logoFile: string): Promise<string[]> => {
      let paths2: string[] = [];
      await runBrief({ slug, prospect: "Northwind Freight" }, {
        demosRepo,
        evidence: evidence({ logo: { file: logoFile, source: "context.dev Retrieve Brand" } }),
        write: () => undefined,
        model: async (_prompt, images) => { paths2 = images.map((image) => image.path); return reply(); },
      });
      return paths2;
    };
    expect(await seen("brand/logo.png")).toContain(paths.logoPng);
    expect(await seen("brand/logo.svg")).not.toContain(paths.logoSvg);
  });

  it("rerolls exactly once when the reply is rejected", async () => {
    const { demosRepo, slug } = await fixture();
    const lines: string[] = [];
    let calls = 0;
    const result = await runBrief({ slug, prospect: "Northwind Freight" }, {
      demosRepo,
      evidence: evidence(),
      write: (line) => lines.push(line),
      model: async () => {
        calls += 1;
        return calls === 1 ? reply({ placement: { trigger: "floating", slot: "x" } }) : reply();
      },
    });
    expect(calls).toBe(2);
    expect(result.brief.placement.trigger).toBe("header");
    expect(lines.join("\n")).toMatch(/rerolling once/);
  });

  it("propagates the second failure saying a reroll already happened, instead of rerolling forever", async () => {
    const { demosRepo, slug } = await fixture();
    let calls = 0;
    // Unprefixed, this error reads as a first-try failure and an operator
    // debugs a flake that already got its second chance.
    const run = runBrief({ slug, prospect: "Northwind Freight" }, {
      demosRepo,
      evidence: evidence(),
      write: () => undefined,
      model: async () => { calls += 1; return reply({ placement: { trigger: "floating", slot: "x" } }); },
    });
    await expect(run).rejects.toThrow(/reroll/i);
    await expect(run).rejects.toThrow(/placement\.trigger/);
    expect(calls).toBe(2);
  });

  it("carries the operator notes into BRIEF.md as authoritative", async () => {
    const { demosRepo, slug } = await fixture();
    await runBrief({ slug, prospect: "Northwind Freight", notes: "Currency is CAD." }, {
      demosRepo,
      evidence: evidence(),
      write: () => undefined,
      model: async () => reply(),
    });
    const markdown = await readFile(demoPaths(demosRepo, slug).brief, "utf8");
    expect(markdown).toMatch(/## OPERATOR NOTES — AUTHORITATIVE/);
    expect(markdown).toContain("Currency is CAD.");
  });

  it("refuses to run the real model seam without a provider key, naming it", async () => {
    const { demosRepo, slug } = await fixture();
    await expect(runBrief({ slug, prospect: "Northwind Freight" }, {
      demosRepo,
      evidence: evidence(),
      write: () => undefined,
      env: {},
    })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
