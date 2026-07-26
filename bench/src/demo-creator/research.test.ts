import { describe, expect, it } from "vitest";
import {
  aggregateFonts,
  aggregatePalette,
  buildResearchReport,
  collectAssetCandidates,
  deriveColorRoles,
  extensionForContentType,
  extractFontFaceSrcUrls,
  isBotChallengeTitle,
  isWebfontLink,
  pageFileStem,
  parseDemoResearchArgs,
  planAssetDownloads,
  type AssetCandidate,
  type PageAssetEvidence,
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
  firstFontFamily: "Inter",
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

describe("deriveColorRoles", () => {
  it("maps the key brand carriers to named roles", () => {
    const roles = deriveColorRoles([
      sample({}),
      sample({ target: "header", backgroundColor: "rgb(10, 10, 10)", color: "rgb(240, 240, 240)" }),
      sample({ target: "nav", backgroundColor: "rgb(15, 15, 15)", color: "rgb(230, 230, 230)" }),
      sample({ target: "button[0]", backgroundColor: "rgb(87, 82, 255)", color: "rgb(255, 255, 255)" }),
      sample({ target: "a[0]", color: "rgb(87, 82, 255)" }),
    ]);
    expect(roles).toEqual([
      { role: "body-bg", color: "rgb(255, 255, 255)", target: "body" },
      { role: "body-text", color: "rgb(20, 20, 20)", target: "body" },
      { role: "header-bg", color: "rgb(10, 10, 10)", target: "header" },
      { role: "header-text", color: "rgb(240, 240, 240)", target: "header" },
      { role: "nav-bg", color: "rgb(15, 15, 15)", target: "nav" },
      { role: "nav-text", color: "rgb(230, 230, 230)", target: "nav" },
      { role: "primary-button-bg", color: "rgb(87, 82, 255)", target: "button[0]" },
      { role: "primary-button-text", color: "rgb(255, 255, 255)", target: "button[0]" },
      { role: "link", color: "rgb(87, 82, 255)", target: "a[0]" },
    ]);
  });

  it("skips transparent backgrounds and picks the first button with a visible background as primary", () => {
    const roles = deriveColorRoles([
      sample({ target: "header", backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(240, 240, 240)" }),
      sample({ target: "button[0]", backgroundColor: "transparent", color: "rgb(20, 20, 20)" }),
      sample({ target: "button[1]", backgroundColor: "rgb(87, 82, 255)", color: "rgb(255, 255, 255)" }),
      sample({ target: "a[0]", color: "rgb(87, 82, 255)" }),
      sample({ target: "a[1]", color: "rgb(0, 0, 0)" }),
    ]);
    expect(roles).toEqual([
      { role: "header-text", color: "rgb(240, 240, 240)", target: "header" },
      { role: "primary-button-bg", color: "rgb(87, 82, 255)", target: "button[1]" },
      { role: "primary-button-text", color: "rgb(255, 255, 255)", target: "button[1]" },
      { role: "link", color: "rgb(87, 82, 255)", target: "a[0]" },
    ]);
  });
});

describe("collectAssetCandidates", () => {
  const evidence: PageAssetEvidence = {
    iconLinks: [
      { rel: "icon", href: "https://acme.example/favicon-32.png", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "https://acme.example/apple-touch-icon.png", sizes: null },
    ],
    metaImages: [
      { kind: "og-image", url: "https://acme.example/og.png" },
      { kind: "twitter-image", url: "https://acme.example/twitter.png" },
    ],
    logoImages: [
      { url: "https://acme.example/img/wordmark.png", source: "nav img", locationHint: "nav", width: 120, height: 32 },
    ],
    logoSvgs: [
      { markup: "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h8v8H0z\"/></svg>", source: "header svg", locationHint: "header", width: 24, height: 24 },
    ],
  };

  it("turns raw page evidence into typed candidates (logos first)", () => {
    const candidates = collectAssetCandidates(evidence);
    expect(candidates.map((candidate) => [candidate.kind, candidate.source])).toEqual([
      ["logo", "header svg"],
      ["logo", "nav img"],
      ["favicon", 'link[rel="icon"]'],
      ["apple-touch-icon", 'link[rel="apple-touch-icon"]'],
      ["og-image", 'meta[property="og:image"]'],
      ["twitter-image", 'meta[name="twitter:image"]'],
    ]);
  });

  it("parses favicon sizes into dimensions and keeps logo dimensions", () => {
    const candidates = collectAssetCandidates(evidence);
    const favicon = candidates.find((candidate) => candidate.kind === "favicon");
    expect(favicon).toMatchObject({ width: 32, height: 32 });
    const touchIcon = candidates.find((candidate) => candidate.kind === "apple-touch-icon");
    expect(touchIcon?.width).toBeUndefined();
    const logoImg = candidates.find((candidate) => candidate.source === "nav img");
    expect(logoImg).toMatchObject({ width: 120, height: 32 });
  });
});

const logoSvg = (markup: string): AssetCandidate => ({
  kind: "logo",
  url: null,
  svgMarkup: markup,
  source: "header svg",
  locationHint: "header",
});

describe("planAssetDownloads", () => {
  it("names files descriptively per kind and derives extensions from the URL (inline SVGs are .svg)", () => {
    const planned = planAssetDownloads([
      logoSvg("<svg><path d=\"M0 0\"/></svg>"),
      { kind: "logo", url: "https://acme.example/img/wordmark.png", source: "nav img", locationHint: "nav" },
      { kind: "favicon", url: "https://acme.example/favicon-32.png", source: 'link[rel="icon"]', width: 32, height: 32 },
      { kind: "og-image", url: "https://acme.example/og.png", source: 'meta[property="og:image"]' },
    ]);
    expect(planned.map((plan) => [plan.fileStem, plan.extension])).toEqual([
      ["logo-1-header", "svg"],
      ["logo-2-nav", "png"],
      ["favicon-32", "png"],
      ["og-image", "png"],
    ]);
  });

  it("leaves the extension null when the URL does not reveal an image extension", () => {
    const planned = planAssetDownloads([
      { kind: "og-image", url: "https://acme.example/brand-card?fmt=large", source: 'meta[property="og:image"]' },
    ]);
    expect(planned[0]?.extension).toBeNull();
  });

  it("dedupes by URL and by inline-SVG content hash", () => {
    const markup = "<svg><circle r=\"4\"/></svg>";
    const planned = planAssetDownloads([
      logoSvg(markup),
      { ...logoSvg(markup), source: "nav svg", locationHint: "nav" },
      { kind: "favicon", url: "https://acme.example/favicon.ico", source: 'link[rel="icon"]' },
      { kind: "favicon", url: "https://acme.example/favicon.ico", source: 'link[rel="shortcut icon"]' },
    ]);
    expect(planned).toHaveLength(2);
    expect(planned.map((plan) => plan.fileStem)).toEqual(["logo-1-header", "favicon"]);
  });

  it("drops non-http(s) URLs (data:, blob:) that have no inline markup", () => {
    const planned = planAssetDownloads([
      { kind: "favicon", url: "data:image/png;base64,iVBORw0KGgo=", source: 'link[rel="icon"]' },
      { kind: "logo", url: "blob:https://acme.example/123", source: "header img", locationHint: "header" },
    ]);
    expect(planned).toEqual([]);
  });

  it("caps the plan, keeping logos over icons and social images", () => {
    const candidates: AssetCandidate[] = [
      { kind: "og-image", url: "https://acme.example/og.png", source: 'meta[property="og:image"]' },
      { kind: "favicon", url: "https://acme.example/favicon.ico", source: 'link[rel="icon"]' },
      logoSvg("<svg><path d=\"M1 1\"/></svg>"),
      { kind: "logo", url: "https://acme.example/logo.png", source: "nav img", locationHint: "nav" },
    ];
    const planned = planAssetDownloads(candidates, { maxAssets: 2 });
    expect(planned.map((plan) => plan.candidate.kind)).toEqual(["logo", "logo"]);
  });

  it("caps logo candidates so favicons and social images survive icon-heavy headers", () => {
    const candidates: AssetCandidate[] = [
      ...Array.from({ length: 15 }, (_, index) => logoSvg(`<svg><path d="M${index} 0"/></svg>`)),
      { kind: "favicon", url: "https://acme.example/favicon.ico", source: 'link[rel="icon"]' },
      { kind: "apple-touch-icon", url: "https://acme.example/apple-touch-icon.png", source: 'link[rel="apple-touch-icon"]' },
      { kind: "og-image", url: "https://acme.example/og.png", source: 'meta[property="og:image"]' },
    ];
    const planned = planAssetDownloads(candidates);
    expect(planned.filter((plan) => plan.candidate.kind === "logo")).toHaveLength(8);
    expect(planned.map((plan) => plan.candidate.kind)).toContain("favicon");
    expect(planned.map((plan) => plan.candidate.kind)).toContain("apple-touch-icon");
    expect(planned.map((plan) => plan.candidate.kind)).toContain("og-image");
    expect(planned.length).toBeLessThanOrEqual(12);
  });

  it("uniquifies stems against names already used by earlier pages", () => {
    const planned = planAssetDownloads(
      [
        { kind: "favicon", url: "https://acme.example/favicon-v2.ico", source: 'link[rel="icon"]' },
        logoSvg("<svg><path d=\"M2 2\"/></svg>"),
      ],
      { usedStems: new Set(["favicon", "logo-1-header"]) },
    );
    expect(planned.map((plan) => plan.fileStem)).toEqual(["logo-1-header-2", "favicon-2"]);
  });
});

describe("extensionForContentType", () => {
  it("maps image content types to file extensions", () => {
    expect(extensionForContentType("image/svg+xml; charset=utf-8")).toBe("svg");
    expect(extensionForContentType("image/png")).toBe("png");
    expect(extensionForContentType("image/jpeg")).toBe("jpg");
    expect(extensionForContentType("image/x-icon")).toBe("ico");
    expect(extensionForContentType("image/vnd.microsoft.icon")).toBe("ico");
    expect(extensionForContentType("image/webp")).toBe("webp");
  });

  it("falls back to a generic extension for unknown types", () => {
    expect(extensionForContentType("application/octet-stream")).toBe("img");
    expect(extensionForContentType("")).toBe("img");
  });
});

describe("isWebfontLink", () => {
  it("recognizes the known webfont hosts", () => {
    expect(isWebfontLink("https://fonts.googleapis.com/css2?family=Inter:wght@400;600")).toBe(true);
    expect(isWebfontLink("https://fonts.gstatic.com/s/inter/v13/x.woff2")).toBe(true);
    expect(isWebfontLink("https://use.typekit.net/abc1def.css")).toBe(true);
    expect(isWebfontLink("https://rsms.me/inter/inter.css")).toBe(true);
    expect(isWebfontLink("https://fonts.bunny.net/css?family=inter")).toBe(true);
  });

  it("rejects same-site stylesheets and junk", () => {
    expect(isWebfontLink("https://acme.example/styles.css")).toBe(false);
    expect(isWebfontLink("not a url")).toBe(false);
  });
});

describe("extractFontFaceSrcUrls", () => {
  it("extracts and resolves every url() in a src declaration against the stylesheet URL", () => {
    expect(extractFontFaceSrcUrls(
      'url("/fonts/inter.woff2") format("woff2"), url(../fonts/inter.woff) format("woff")',
      "https://acme.example/css/app.css",
    )).toEqual([
      "https://acme.example/fonts/inter.woff2",
      "https://acme.example/fonts/inter.woff",
    ]);
  });

  it("skips data: URLs and dedupes", () => {
    expect(extractFontFaceSrcUrls(
      "url(data:font/woff2;base64,d09G) format(\"woff2\"), url('/a.woff2'), url(\"/a.woff2\")",
      "https://acme.example/app.css",
    )).toEqual(["https://acme.example/a.woff2"]);
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

const capturedPage = (overrides: Partial<Extract<ResearchPageEntry, { title: string }>>): ResearchPageEntry => ({
  url: "https://acme.example",
  title: "Acme",
  themeColor: "#5752ff",
  favicon: "https://acme.example/favicon.ico",
  botChallenge: false,
  screenshots: { viewport: "page-1-acme-example-viewport.png", fullPage: "page-1-acme-example-full.png" },
  samples: [sample({})],
  colorRoles: deriveColorRoles([sample({})]),
  fontFaces: [],
  webfontLinks: [],
  assets: [],
  ...overrides,
});

describe("aggregateFonts", () => {
  it("dedupes resolved families, @font-face sources, and webfont links across pages", () => {
    const fonts = aggregateFonts([
      capturedPage({
        samples: [sample({ firstFontFamily: "Inter Variable" }), sample({ target: "header", firstFontFamily: "Inter Variable" })],
        fontFaces: [{ family: "Inter Variable", src: "https://acme.example/fonts/inter-var.woff2" }],
        webfontLinks: ["https://rsms.me/inter/inter.css"],
      }),
      capturedPage({
        url: "https://acme.example/pricing",
        samples: [sample({ firstFontFamily: "Inter Variable" }), sample({ target: "a[0]", firstFontFamily: "Berkeley Mono" })],
        fontFaces: [
          { family: "Inter Variable", src: "https://acme.example/fonts/inter-var.woff2" },
          { family: "Berkeley Mono", src: "https://acme.example/fonts/berkeley.woff2" },
        ],
        webfontLinks: ["https://rsms.me/inter/inter.css"],
      }),
      { url: "https://acme.example/broken", error: "net::ERR_NAME_NOT_RESOLVED" },
    ]);
    expect(fonts).toEqual({
      families: ["Inter Variable", "Berkeley Mono"],
      faceSrcs: [
        { family: "Inter Variable", src: "https://acme.example/fonts/inter-var.woff2" },
        { family: "Berkeley Mono", src: "https://acme.example/fonts/berkeley.woff2" },
      ],
      webfontLinks: ["https://rsms.me/inter/inter.css"],
    });
  });

  it("skips empty resolved families", () => {
    const fonts = aggregateFonts([capturedPage({ samples: [sample({ firstFontFamily: "" })] })]);
    expect(fonts.families).toEqual([]);
  });
});

describe("buildResearchReport", () => {
  it("shapes research.json with palette and fonts aggregated over successful pages only", () => {
    const pages: ResearchPageEntry[] = [
      capturedPage({
        fontFaces: [{ family: "Inter", src: "https://acme.example/fonts/inter.woff2" }],
        webfontLinks: ["https://fonts.googleapis.com/css2?family=Inter"],
        assets: [{
          kind: "logo",
          source: "header svg",
          url: null,
          file: "assets/logo-1-header.svg",
          width: 24,
          height: 24,
        }],
      }),
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
      fonts: {
        families: ["Inter"],
        faceSrcs: [{ family: "Inter", src: "https://acme.example/fonts/inter.woff2" }],
        webfontLinks: ["https://fonts.googleapis.com/css2?family=Inter"],
      },
    });
  });
});
