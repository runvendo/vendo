import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContextDevError } from "./context-dev.js";
import type { BrandLogo, BrandRetrieveResult, ContextDevClient, FontsResult, MarkdownResult, StyleguideResult } from "./context-dev.js";
import { evidenceFileName, pickLogo, readEvidence, runEvidence } from "./evidence.js";
import { demoPaths } from "./demo-folder.js";

const brand: BrandRetrieveResult = {
  title: "Acme",
  description: "Acme does things",
  domain: "acme.com",
  colors: [{ hex: "#1A73E8", name: "blue" }, { hex: "#fff" }, { hex: "#0F9D58" }, { hex: "not-a-hex" }],
  logos: [{ url: "https://media.brand.dev/acme/logo.svg", mode: "light", type: "logo" }],
  raw: { status: "ok", brand: { title: "Acme" } },
};

const styleguide: StyleguideResult = {
  mode: "light",
  colors: { accent: "#1A73E8", background: "#FFFFFF", text: "#111111" },
  typography: { headings: { h1: { fontFamily: "Inter" } }, p: { fontFamily: "Inter" } },
  raw: { status: "ok", styleguide: { mode: "light" } },
};

const fonts: FontsResult = {
  fonts: [{ font: "Inter", uses: ["body"], fallbacks: ["sans-serif"], percent_words: 90, percent_elements: 88 }],
  raw: { status: "ok", fonts: [{ font: "Inter" }] },
};

const markdown: MarkdownResult = {
  markdown: "# Acme\n\nThings, done.",
  contentLength: 21,
  url: "https://acme.com/",
  metadata: { title: "Acme — things, done" },
  raw: { success: true, markdown: "# Acme" },
};

function fakeClient(overrides: Partial<ContextDevClient> = {}): ContextDevClient {
  return {
    retrieveBrand: async () => brand,
    styleguide: async () => styleguide,
    fonts: async () => fonts,
    scrapeMarkdown: async () => markdown,
    ...overrides,
  };
}

const svgResponse = (): Response =>
  new Response('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>', {
    headers: { "content-type": "image/svg+xml" },
  });

const pngResponse = (): Response =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
    headers: { "content-type": "image/png" },
  });

/** A demos-repo checkout plus operator screenshot files on disk. */
async function fixture(names: string[] = ["home.png"]): Promise<{ demosRepo: string; screenshots: string[] }> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-evidence-repo-"));
  const inbox = await mkdtemp(path.join(tmpdir(), "vendo-evidence-inbox-"));
  const screenshots: string[] = [];
  for (const [index, name] of names.entries()) {
    const dir = path.join(inbox, String(index));
    await mkdtemp(`${dir}-`).then(async (made) => {
      const file = path.join(made, name);
      await writeFile(file, `bytes for ${name} ${index}`);
      screenshots.push(file);
    });
  }
  return { demosRepo, screenshots };
}

const args = { slug: "acme", prospect: "Acme", url: "https://www.acme.com/pricing" };

describe("runEvidence screenshots", () => {
  it("copies every operator screenshot into RESEARCH/ under an indexed name", async () => {
    const { demosRepo, screenshots } = await fixture(["screenshot.png", "screenshot.png"]);

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    // Two files with the same basename must not collide — the index makes the
    // reference order visible to the brief and to the side-by-side reply.
    expect(result.screenshots.map((entry) => entry.file)).toEqual(["1-screenshot.png", "2-screenshot.png"]);
    const research = demoPaths(demosRepo, "acme").researchDir;
    await expect(readFile(path.join(research, "1-screenshot.png"), "utf8")).resolves.toBe("bytes for screenshot.png 0");
    await expect(readFile(path.join(research, "2-screenshot.png"), "utf8")).resolves.toBe("bytes for screenshot.png 1");
  });

  // evidence.json is committed to the vendo-demos repo, so the operator's
  // /Users/<name>/Downloads/... path would be published with every demo.
  it("records only the basename of the operator's file, never their local path", async () => {
    const { demosRepo, screenshots } = await fixture(["home.png"]);

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.screenshots.map((entry) => entry.source)).toEqual(["home.png"]);
    const digest = await readFile(path.join(demoPaths(demosRepo, "acme").researchDir, evidenceFileName), "utf8");
    expect(digest).not.toContain(path.dirname(screenshots[0]!));
  });

  // The screenshots ARE the brief's reference material; there is no demo to
  // build without them.
  it("refuses to run with no screenshots at all", async () => {
    const { demosRepo } = await fixture();
    await expect(runEvidence({ ...args, screenshots: [] }, { demosRepo, client: fakeClient(), write: () => {} }))
      .rejects.toThrow(/at least one reference screenshot/i);
  });

  it("names the path when an operator screenshot cannot be read", async () => {
    const { demosRepo, screenshots } = await fixture();
    const missing = path.join(path.dirname(screenshots[0]!), "typo.png");
    await expect(runEvidence({ ...args, screenshots: [...screenshots, missing] }, {
      demosRepo,
      client: fakeClient(),
      write: () => {},
    })).rejects.toThrow(missing);
  });
});

describe("runEvidence context.dev calls", () => {
  it("uses the domain from --url and records every raw response", async () => {
    const { demosRepo, screenshots } = await fixture();
    const client = fakeClient();
    const retrieveBrand = vi.spyOn(client, "retrieveBrand");
    const styleguideCall = vi.spyOn(client, "styleguide");
    const fontsCall = vi.spyOn(client, "fonts");
    const scrape = vi.spyOn(client, "scrapeMarkdown");

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client,
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(retrieveBrand).toHaveBeenCalledWith({ domain: "acme.com" });
    expect(styleguideCall).toHaveBeenCalledWith({ domain: "acme.com" });
    expect(fontsCall).toHaveBeenCalledWith({ domain: "acme.com" });
    expect(scrape).toHaveBeenCalledWith({ url: "https://www.acme.com/pricing", useMainContentOnly: true });
    expect(result.soft).toEqual([]);
    expect(result.rawFiles).toEqual([
      "context-dev/retrieve-brand.json",
      "context-dev/styleguide.json",
      "context-dev/fonts.json",
      "context-dev/scrape-markdown.json",
    ]);
    const research = demoPaths(demosRepo, "acme").researchDir;
    const raw = JSON.parse(await readFile(path.join(research, "context-dev", "retrieve-brand.json"), "utf8")) as unknown;
    expect(raw).toEqual(brand.raw);
    // The digest itself stays readable — the verbatim bodies live in their own files.
    expect(result.brand).not.toHaveProperty("raw");
  });

  it("writes the site text to a markdown file the brief can read", async () => {
    const { demosRepo, screenshots } = await fixture();
    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.markdown).toEqual({ file: "site.md", title: "Acme — things, done" });
    const research = demoPaths(demosRepo, "acme").researchDir;
    await expect(readFile(path.join(research, "site.md"), "utf8")).resolves.toContain("Things, done.");
  });

  // Without --url the three domain/url-keyed calls have nothing to key off;
  // brand-by-name is still worth asking for.
  it("asks for the brand by name and skips the site-keyed calls with no --url", async () => {
    const { demosRepo, screenshots } = await fixture();
    const client = fakeClient();
    const retrieveBrand = vi.spyOn(client, "retrieveBrand");
    const styleguideCall = vi.spyOn(client, "styleguide");

    const result = await runEvidence({ slug: "acme", prospect: "Acme", screenshots }, {
      demosRepo,
      client,
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(retrieveBrand).toHaveBeenCalledWith({ name: "Acme" });
    expect(styleguideCall).not.toHaveBeenCalled();
    expect(result.soft.map((entry) => entry.call)).toEqual(["styleguide", "fonts", "scrape-markdown"]);
    for (const entry of result.soft) expect(entry.reason).toMatch(/no --url/);
    // Brand colours alone still give the brief a palette to copy from.
    expect(result.palette).toEqual(["#1A73E8", "#FFFFFF", "#0F9D58"]);
    expect(result.styleguide).toBeUndefined();
  });

  // A --url that was given but does not parse is a different problem from no
  // --url at all, and "no --url given" would send the operator hunting for a
  // flag they already typed.
  it("does not claim '--url' was missing when one was given but does not resolve", async () => {
    const { demosRepo, screenshots } = await fixture();

    const result = await runEvidence({ slug: "acme", prospect: "Acme", url: "not a url", screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    const reasons = result.soft.filter((entry) => entry.call !== "logo").map((entry) => entry.reason);
    expect(reasons).not.toHaveLength(0);
    for (const reason of reasons) {
      expect(reason).not.toMatch(/no --url given/);
      expect(reason).toContain("not a url");
    }
  });

  const failures: [string, keyof ContextDevClient][] = [
    ["retrieve-brand", "retrieveBrand"],
    ["styleguide", "styleguide"],
    ["fonts", "fonts"],
    ["scrape-markdown", "scrapeMarkdown"],
  ];

  for (const [call, method] of failures) {
    it(`keeps going when ${call} fails, and says so`, async () => {
      const { demosRepo, screenshots } = await fixture();
      const client = fakeClient({
        [method]: async () => {
          throw new ContextDevError({ status: 500, endpoint: `X ${call}`, message: "upstream exploded" });
        },
      } as Partial<ContextDevClient>);
      const lines: string[] = [];

      const result = await runEvidence({ ...args, screenshots }, {
        demosRepo,
        client,
        fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
        write: (line) => lines.push(line),
      });

      expect(result.soft.map((entry) => entry.call)).toContain(call);
      expect(result.soft.find((entry) => entry.call === call)?.reason).toContain("upstream exploded");
      expect(lines.join("\n")).toContain(call);
      // Everything else still landed, and the run is usable.
      expect(result.screenshots).toHaveLength(1);
      expect(result.palette.length).toBeGreaterThan(0);
      // A failure is recorded in the same place a success would be.
      const envelope = JSON.parse(await readFile(
        path.join(demoPaths(demosRepo, "acme").researchDir, "context-dev", `${call}.json`),
        "utf8",
      )) as { status?: string; message?: string };
      expect(envelope.status).toBe("error");
      expect(envelope.message).toContain("upstream exploded");
    });
  }

  it("falls back to the brand palette when only the styleguide call fails", async () => {
    const { demosRepo, screenshots } = await fixture();
    const client = fakeClient({
      styleguide: async () => {
        throw new ContextDevError({ status: 404, endpoint: "GET /web/styleguide", message: "no styleguide" });
      },
    });

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client,
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.palette).toEqual(["#1A73E8", "#FFFFFF", "#0F9D58"]);
  });
});

describe("runEvidence palette", () => {
  it("puts the rendered styleguide colours first, then the logo colours, deduped", async () => {
    const { demosRepo, screenshots } = await fixture();

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    // accent, background, text (what the site actually renders) lead; "#fff"
    // folds onto "#FFFFFF"; "not-a-hex" is dropped rather than handed to a theme.
    expect(result.palette).toEqual(["#1A73E8", "#FFFFFF", "#111111", "#0F9D58"]);
  });
});

describe("pickLogo", () => {
  const logo = (extra: Partial<BrandLogo>): BrandLogo => ({ url: "https://media.brand.dev/x", ...extra });

  it("prefers a wordmark over an icon even when the icon is bigger", () => {
    const chosen = pickLogo([
      logo({ url: "icon", type: "icon", resolution: { width: 512, height: 512, aspect_ratio: 1 } }),
      logo({ url: "wordmark", type: "logo", resolution: { width: 200, height: 60, aspect_ratio: 3.3 } }),
    ]);
    expect(chosen?.url).toBe("wordmark");
  });

  it("prefers a light or opaque-background logo over a dark one", () => {
    expect(pickLogo([logo({ url: "dark", mode: "dark" }), logo({ url: "light", mode: "light" })])?.url).toBe("light");
    expect(pickLogo([
      logo({ url: "dark", mode: "dark" }),
      logo({ url: "opaque", mode: "has_opaque_background" }),
    ])?.url).toBe("opaque");
  });

  it("takes the largest of otherwise equal candidates", () => {
    expect(pickLogo([
      logo({ url: "small", type: "logo", mode: "light", resolution: { width: 100, height: 30, aspect_ratio: 3.3 } }),
      logo({ url: "big", type: "logo", mode: "light", resolution: { width: 600, height: 180, aspect_ratio: 3.3 } }),
    ])?.url).toBe("big");
  });

  it("has no opinion when there are no logos", () => {
    expect(pickLogo([])).toBeUndefined();
  });
});

describe("runEvidence logo download", () => {
  it("saves SVG bytes as brand/logo.svg", async () => {
    const { demosRepo, screenshots } = await fixture();
    const fetchImpl = vi.fn().mockResolvedValue(svgResponse());

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => {},
    });

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://media.brand.dev/acme/logo.svg");
    expect(result.logo).toEqual({ file: "brand/logo.svg", source: "https://media.brand.dev/acme/logo.svg" });
    await expect(readFile(demoPaths(demosRepo, "acme").logoSvg, "utf8")).resolves.toContain("<svg");
  });

  // brand.dev serves plenty of PNG "logo.svg"-ish CDN URLs; the bytes decide.
  it("saves non-SVG bytes as brand/logo.png", async () => {
    const { demosRepo, screenshots } = await fixture();

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(pngResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.logo).toEqual({ file: "brand/logo.png", source: "https://media.brand.dev/acme/logo.svg" });
    await expect(readFile(demoPaths(demosRepo, "acme").logoPng)).resolves.toBeTruthy();
  });

  it("fails soft when the logo download fails", async () => {
    const { demosRepo, screenshots } = await fixture();

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 403 })) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.logo).toBeUndefined();
    expect(result.soft.map((entry) => entry.call)).toEqual(["logo"]);
    expect(result.soft[0]?.reason).toContain("403");
  });

  it("fails soft when the brand has no logo to download", async () => {
    const { demosRepo, screenshots } = await fixture();
    const client = fakeClient({ retrieveBrand: async () => ({ ...brand, logos: [] }) });

    const result = await runEvidence({ ...args, screenshots }, { demosRepo, client, write: () => {} });

    expect(result.logo).toBeUndefined();
    expect(result.soft.map((entry) => entry.call)).toEqual(["logo"]);
  });

  // The failure that reaches the judge: a CDN answering 200 with an HTML "403
  // Forbidden" page. `response.ok` is true, the bytes get written to
  // brand/logo.png, the digest records SUCCESS, the demo commits a broken image,
  // and the judge then scores logo fidelity against it.
  it("fails soft when a 200 response is not actually an image", async () => {
    const { demosRepo, screenshots } = await fixture();
    const htmlWith200 = new Response(
      "<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Access denied</body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );

    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(htmlWith200) as unknown as typeof fetch,
      write: () => {},
    });

    expect(result.logo).toBeUndefined();
    expect(result.soft.map((entry) => entry.call)).toEqual(["logo"]);
    expect(result.soft[0]?.reason).toMatch(/not an image/i);
    // Nothing was written: a broken file on disk is worse than no file, because
    // the brief and the judge both treat presence as success.
    await expect(readFile(demoPaths(demosRepo, "acme").logoPng)).rejects.toThrow();
    await expect(readFile(demoPaths(demosRepo, "acme").logoSvg)).rejects.toThrow();
  });

  it("accepts every image format the CDN actually serves", async () => {
    const cases: [string, Uint8Array, "png" | "svg"][] = [
      ["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png"],
      ["jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "png"],
      ["gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), "png"],
      ["webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "png"],
      ["ico", new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), "png"],
    ];
    for (const [label, bytes, expected] of cases) {
      const { demosRepo, screenshots } = await fixture();
      const result = await runEvidence({ ...args, screenshots }, {
        demosRepo,
        client: fakeClient(),
        fetchImpl: vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })) as unknown as typeof fetch,
        write: () => {},
      });
      expect(result.logo, label).toEqual({ file: `brand/logo.${expected}`, source: "https://media.brand.dev/acme/logo.svg" });
    }
  });
});

// The same HTML-with-200 class on the text half of the evidence: a Cloudflare
// interstitial or an error page scraped as "markdown" becomes the site text the
// brand brief derives vocabulary and voice from.
describe("runEvidence scraped site text", () => {
  const errorPages = [
    ["a Cloudflare interstitial", "Just a moment...\n\nEnable JavaScript and cookies to continue"],
    ["an HTML error page", "<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>nginx</body></html>"],
    ["an access-denied page", "# Access Denied\n\nYou do not have permission to access this resource."],
    ["an empty scrape", "   \n\n"],
  ] as const;

  for (const [label, body] of errorPages) {
    it(`records ${label} as a soft failure instead of feeding it to the brief`, async () => {
      const { demosRepo, screenshots } = await fixture();
      const client = fakeClient({
        scrapeMarkdown: async () => ({ ...markdown, markdown: body, contentLength: body.length }),
      });

      const result = await runEvidence({ ...args, screenshots }, {
        demosRepo,
        client,
        fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
        write: () => {},
      });

      expect(result.markdown).toBeUndefined();
      expect(result.soft.map((entry) => entry.call)).toContain("scrape-markdown");
      await expect(readFile(path.join(demoPaths(demosRepo, "acme").researchDir, "site.md"), "utf8")).rejects.toThrow();
    });
  }

  it("still accepts real site text", async () => {
    const { demosRepo, screenshots } = await fixture();
    const result = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });
    expect(result.markdown).toEqual({ file: "site.md", title: "Acme — things, done" });
    await expect(readFile(path.join(demoPaths(demosRepo, "acme").researchDir, "site.md"), "utf8"))
      .resolves.toContain("Things, done.");
  });
});

// Re-running one slug in one checkout is exactly what the host fence's agent-window
// baseline now enables, so the stale-file hazard stops being theoretical: the
// evidence stage only ever mkdir'd, so a PREVIOUS run's logo survived a current
// soft failure, got committed, and the fidelity judge scored brand fidelity
// against an asset from another prospect or another week.
describe("runEvidence on a slug that already has evidence", () => {
  it("clears the previous run's evidence instead of writing over part of it", async () => {
    const { demosRepo, screenshots } = await fixture(["home.png"]);
    const paths = demoPaths(demosRepo, "acme");

    // A first run leaves a full evidence set behind.
    await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });
    // …plus the artifacts only a LATER stage writes, which are equally stale on a
    // rebuild, and the one file that must survive: this run's own timings.
    await writeFile(path.join(paths.researchDir, "FIDELITY.md"), "stale scores from the last run\n");
    await writeFile(paths.timings, '[{"stage":"repo","startedAt":"x","ms":1,"depth":0}]\n');
    await expect(readFile(path.join(paths.brandDir, "logo.svg"), "utf8")).resolves.toContain("<svg");

    // The second run is for a DIFFERENT prospect on the same slug, and its logo
    // fetch soft-fails — the exact shape that used to ship the old logo.
    const second = await fixture(["dashboard.png"]);
    const result = await runEvidence(
      { slug: "acme", prospect: "Other Co", url: "https://other.example", screenshots: second.screenshots },
      {
        demosRepo,
        client: fakeClient({ retrieveBrand: async () => ({ ...brand, logos: [] }) }),
        fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
        write: () => {},
      },
    );

    // The soft failure is honest: no logo this run…
    expect(result.logo).toBeUndefined();
    expect(result.soft.map((entry) => entry.call)).toContain("logo");
    // …and critically, the PREVIOUS run's logo is gone rather than inherited.
    await expect(readFile(path.join(paths.brandDir, "logo.svg"), "utf8")).rejects.toThrow(/ENOENT/);
    // The previous run's screenshot and stale report went with it.
    await expect(readFile(path.join(paths.researchDir, "1-home.png"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(path.join(paths.researchDir, "FIDELITY.md"), "utf8")).rejects.toThrow(/ENOENT/);
    // This run's own screenshot is there.
    await expect(readFile(path.join(paths.researchDir, "1-dashboard.png"), "utf8")).resolves.toContain("bytes for dashboard.png");
    // …and the run's timing evidence, written before evidence ran, SURVIVED.
    await expect(readFile(paths.timings, "utf8")).resolves.toContain('"repo"');
  });
});

describe("readEvidence", () => {
  it("round-trips the digest stage 2 and demo:fix read", async () => {
    const { demosRepo, screenshots } = await fixture();
    const written = await runEvidence({ ...args, screenshots }, {
      demosRepo,
      client: fakeClient(),
      fetchImpl: vi.fn().mockResolvedValue(svgResponse()) as unknown as typeof fetch,
      write: () => {},
    });

    await expect(readEvidence(demosRepo, "acme")).resolves.toEqual(written);
    // One file, at the frozen location.
    await expect(readFile(path.join(demoPaths(demosRepo, "acme").researchDir, evidenceFileName), "utf8"))
      .resolves.toContain("palette");
  });
});
