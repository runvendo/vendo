import { describe, expect, it } from "vitest";
import {
  aggregatePalette,
  buildResearchReport,
  isBotChallengeTitle,
  pageFileStem,
  parseDemoResearchArgs,
  type ResearchPageEntry,
  type StyleSample,
} from "./research.js";

describe("parseDemoResearchArgs", () => {
  it("parses an app directory with repeatable --url", () => {
    expect(parseDemoResearchArgs([
      "--app", "apps/demo-acme",
      "--url", "https://acme.example",
      "--url", "https://acme.example/pricing",
    ])).toEqual({
      app: "apps/demo-acme",
      urls: ["https://acme.example", "https://acme.example/pricing"],
    });
  });

  it("accepts the literal separator forwarded by pnpm scripts", () => {
    expect(parseDemoResearchArgs(["--", "--app", "apps/demo-acme", "--url", "https://acme.example"]))
      .toMatchObject({ app: "apps/demo-acme" });
  });

  it("requires --app and at least one --url", () => {
    expect(() => parseDemoResearchArgs(["--url", "https://acme.example"])).toThrow("--app is required");
    expect(() => parseDemoResearchArgs(["--app", "apps/demo-acme"])).toThrow("--url is required");
  });

  it("rejects unknown options and non-http(s) URLs", () => {
    expect(() => parseDemoResearchArgs(["--app", "apps/demo-acme", "--headed"])).toThrow("Unknown option: --headed");
    expect(() => parseDemoResearchArgs(["--app", "apps/demo-acme", "--url", "ftp://acme.example"]))
      .toThrow("--url must be an http(s) URL");
  });
});

const sample = (overrides: Partial<StyleSample>): StyleSample => ({
  target: "body",
  color: "rgb(20, 20, 20)",
  backgroundColor: "rgb(255, 255, 255)",
  fontFamily: "Inter, sans-serif",
  borderRadius: "0px",
  ...overrides,
});

describe("aggregatePalette", () => {
  it("dedupes colors and font families across samples, preserving first-seen order", () => {
    const palette = aggregatePalette([
      sample({}),
      sample({ target: "button[0]", color: "rgb(255, 255, 255)", backgroundColor: "rgb(87, 82, 255)" }),
      sample({ target: "a[0]", color: "rgb(87, 82, 255)", fontFamily: "Inter, sans-serif" }),
    ]);
    expect(palette.colors).toEqual([
      "rgb(20, 20, 20)",
      "rgb(255, 255, 255)",
      "rgb(87, 82, 255)",
    ]);
    expect(palette.fontFamilies).toEqual(["Inter, sans-serif"]);
  });

  it("drops transparent and empty values", () => {
    const palette = aggregatePalette([
      sample({ backgroundColor: "rgba(0, 0, 0, 0)" }),
      sample({ color: "transparent", backgroundColor: "", fontFamily: "" }),
    ]);
    expect(palette.colors).toEqual(["rgb(20, 20, 20)"]);
    expect(palette.fontFamilies).toEqual(["Inter, sans-serif"]);
  });
});

describe("isBotChallengeTitle", () => {
  it("flags the obvious bot-wall titles", () => {
    expect(isBotChallengeTitle("Just a moment...")).toBe(true);
    expect(isBotChallengeTitle("Access Denied")).toBe(true);
  });

  it("passes ordinary product titles", () => {
    expect(isBotChallengeTitle("Linear – Plan and build products")).toBe(false);
    expect(isBotChallengeTitle("")).toBe(false);
  });
});

describe("pageFileStem", () => {
  it("derives an ordered, filesystem-safe stem from the URL", () => {
    expect(pageFileStem("https://linear.app/", 0)).toBe("page-1-linear-app");
    expect(pageFileStem("https://acme.example/Pricing/Teams?x=1", 1)).toBe("page-2-acme-example-pricing-teams");
  });
});

describe("buildResearchReport", () => {
  it("shapes research.json with the palette aggregated over successful pages only", () => {
    const pages: ResearchPageEntry[] = [
      {
        url: "https://acme.example",
        title: "Acme",
        themeColor: "#5752ff",
        favicon: "https://acme.example/favicon.ico",
        botChallenge: false,
        screenshots: { viewport: "page-1-acme-example-viewport.png", fullPage: "page-1-acme-example-full.png" },
        samples: [sample({})],
      },
      { url: "https://acme.example/pricing", error: "net::ERR_NAME_NOT_RESOLVED" },
    ];
    const report = buildResearchReport({
      urls: ["https://acme.example", "https://acme.example/pricing"],
      pages,
      capturedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(report).toEqual({
      capturedAt: "2026-07-16T00:00:00.000Z",
      urls: ["https://acme.example", "https://acme.example/pricing"],
      pages,
      palette: {
        colors: ["rgb(20, 20, 20)", "rgb(255, 255, 255)"],
        fontFamilies: ["Inter, sans-serif"],
      },
    });
  });
});
