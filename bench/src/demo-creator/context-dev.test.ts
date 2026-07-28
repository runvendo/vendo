import { describe, expect, it, vi } from "vitest";
import { ContextDevError, createContextDevClient, domainFromUrl } from "./context-dev.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(responses: Response[], apiKey = "ctx_live_test"): {
  api: ReturnType<typeof createContextDevClient>;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return {
    api: createContextDevClient({ apiKey, fetchImpl: fetchImpl as unknown as typeof fetch }),
    fetchImpl,
  };
}

describe("createContextDevClient credential posture", () => {
  // The operator runs this from a shell; an SDK-style 401 five seconds into the
  // first call tells them nothing about where the key comes from.
  it("names CONTEXT_DEV_API_KEY and where it lives when the key is missing", () => {
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");
    expect(() => createContextDevClient()).toThrow(/CONTEXT_DEV_API_KEY[\s\S]*Infisical/);
    vi.unstubAllEnvs();
  });

  it("takes the key from the environment when the caller passes none", async () => {
    vi.stubEnv("CONTEXT_DEV_API_KEY", "ctx_from_env");
    const fetchImpl = vi.fn().mockResolvedValue(json({ brand: {} }));
    const api = createContextDevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.retrieveBrand({ domain: "acme.com" });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ctx_from_env");
    vi.unstubAllEnvs();
  });

  // Every failure path is written to RESEARCH/ and printed to the operator's
  // terminal, so a key that leaks into one error message leaks to disk.
  it("keeps the key out of the error a failed call throws", async () => {
    const { api } = client([json({ message: "invalid api key", status: "error", error_code: "unauthorized" }, 401)]);
    await expect(api.retrieveBrand({ domain: "acme.com" })).rejects.toThrow(/invalid api key/);
    await expect(api.retrieveBrand({ domain: "acme.com" })).rejects.not.toThrow(/ctx_live_test/);
  });
});

describe("retrieveBrand", () => {
  it("posts the by_domain variant to the v1 base URL with bearer auth", async () => {
    const { api, fetchImpl } = client([json({ status: "ok", code: 200, brand: { title: "Acme" } })]);

    await api.retrieveBrand({ domain: "acme.com" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.context.dev/v1/brand/retrieve");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ctx_live_test");
    expect(JSON.parse(init.body as string)).toEqual({ type: "by_domain", domain: "acme.com" });
  });

  it("posts the by_name variant when there is no site to key off", async () => {
    const { api, fetchImpl } = client([json({ brand: { title: "Acme" } })]);
    await api.retrieveBrand({ name: "Acme Corp" });
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string))
      .toEqual({ type: "by_name", name: "Acme Corp" });
  });

  it("keeps colors in prominence order and logos with their mode, type and size", async () => {
    const { api } = client([json({
      brand: {
        title: "Acme",
        description: "Acme does things",
        slogan: "Things, done",
        domain: "acme.com",
        colors: [{ hex: "#1A73E8", name: "blue" }, { hex: "#0F9D58" }],
        logos: [{
          url: "https://media.brand.dev/acme/logo.svg",
          mode: "light",
          type: "logo",
          resolution: { width: 200, height: 60, aspect_ratio: 3.33 },
        }],
      },
    })]);

    const result = await api.retrieveBrand({ domain: "acme.com" });

    expect(result.title).toBe("Acme");
    expect(result.slogan).toBe("Things, done");
    expect(result.colors).toEqual([{ hex: "#1A73E8", name: "blue" }, { hex: "#0F9D58" }]);
    expect(result.logos).toEqual([{
      url: "https://media.brand.dev/acme/logo.svg",
      mode: "light",
      type: "logo",
      resolution: { width: 200, height: 60, aspect_ratio: 3.33 },
    }]);
  });

  // The OpenAPI spec marks NOTHING inside `brand` as required, and an unknown
  // prospect really does come back like this.
  it("survives a brand object with nothing in it", async () => {
    const { api } = client([json({ status: "ok", brand: {} })]);
    await expect(api.retrieveBrand({ name: "Nobody" })).resolves.toMatchObject({ colors: [], logos: [] });
  });

  it("drops a logo with no URL and a mode the spec does not define", async () => {
    const { api } = client([json({
      brand: { logos: [{ mode: "light" }, { url: "https://media.brand.dev/a.png", mode: "sepia" }] },
    })]);
    const result = await api.retrieveBrand({ domain: "acme.com" });
    expect(result.logos).toEqual([{ url: "https://media.brand.dev/a.png" }]);
  });

  // RESEARCH/context-dev/*.json is the evidence a human debugs fidelity with,
  // so the narrowed result carries the body it was narrowed from.
  it("carries the verbatim response body on raw", async () => {
    const body = { status: "ok", code: 200, brand: { title: "Acme", industries: [{ id: "tech" }] } };
    const { api } = client([json(body)]);
    await expect(api.retrieveBrand({ domain: "acme.com" })).resolves.toMatchObject({ raw: body });
  });
});

describe("error envelopes", () => {
  it("joins a validation envelope's issue array into one message", async () => {
    const { api } = client([json({
      message: [
        { code: "too_small", message: "domain must be at least 3 characters", path: ["domain"] },
        { code: "invalid_type", message: "expected string", path: ["type"] },
      ],
      status: "error",
      error_code: "bad_request",
    }, 400)]);

    const error = await api.retrieveBrand({ domain: "ac" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContextDevError);
    const failure = error as ContextDevError;
    expect(failure.status).toBe(400);
    expect(failure.endpoint).toBe("POST /brand/retrieve");
    expect(failure.errorCode).toBe("bad_request");
    expect(failure.message).toContain("domain must be at least 3 characters");
    expect(failure.message).toContain("expected string");
  });

  // 429 is the one envelope that spells the code `code`, not `error_code`.
  it("reads the rate-limit code out of a 429's `code` field", async () => {
    const { api } = client([json({ message: "rate limit exceeded", status: "error", code: "rate_limited" }, 429)]);
    const error = await api.fonts({ domain: "acme.com" }).catch((caught: unknown) => caught) as ContextDevError;
    expect(error.status).toBe(429);
    expect(error.errorCode).toBe("rate_limited");
    expect(error.message).toContain("rate limit exceeded");
  });

  it("still names the endpoint and status when the body is not JSON at all", async () => {
    const { api } = client([new Response("<html>502 Bad Gateway</html>", { status: 502 })]);
    const error = await api.styleguide({ domain: "acme.com" }).catch((caught: unknown) => caught) as ContextDevError;
    expect(error.status).toBe(502);
    expect(error.endpoint).toBe("GET /web/styleguide");
    expect(error.errorCode).toBeUndefined();
  });
});

describe("styleguide", () => {
  it("keys off the domain and passes the requested colour scheme", async () => {
    const { api, fetchImpl } = client([json({
      status: "ok",
      domain: "acme.com",
      styleguide: {
        mode: "dark",
        colors: { accent: "#1A73E8", background: "#0B0B0B", text: "#F5F5F5" },
        typography: {
          headings: { h1: { fontFamily: "Inter", fontSize: "48px", fontWeight: 700 } },
          p: { fontFamily: "Inter", fontSize: "16px" },
        },
        elementSpacing: { sm: "8px", md: "16px" },
        shadows: { sm: "0 1px 2px rgba(0,0,0,.2)" },
        fontLinks: { Inter: { type: "google", category: "sans-serif", files: { "400": "https://fonts.gstatic.com/i.woff2" } } },
        components: { button: { primary: { backgroundColor: "#1A73E8", borderRadius: "6px" } }, card: { borderRadius: "12px" } },
      },
    })]);

    const result = await api.styleguide({ domain: "acme.com", colorScheme: "dark" });

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.context.dev/v1/web/styleguide?domain=acme.com&colorScheme=dark");
    expect(result.colors).toEqual({ accent: "#1A73E8", background: "#0B0B0B", text: "#F5F5F5" });
    // fontWeight arrives as a number in real payloads; the brief reads strings.
    expect(result.typography?.headings?.h1).toEqual({ fontFamily: "Inter", fontSize: "48px", fontWeight: "700" });
    expect(result.typography?.p?.fontFamily).toBe("Inter");
    expect(result.elementSpacing).toEqual({ sm: "8px", md: "16px" });
    expect(result.fontLinks?.Inter?.files).toEqual({ "400": "https://fonts.gstatic.com/i.woff2" });
    // The brief reads these straight into theme tokens, so they stay CSS strings.
    expect(result.components?.button?.primary).toEqual({ backgroundColor: "#1A73E8", borderRadius: "6px" });
    expect(result.components?.card?.borderRadius).toBe("12px");
  });

  it("omits colorScheme when the caller does not ask for one", async () => {
    const { api, fetchImpl } = client([json({ styleguide: { colors: { accent: "#1A73E8", background: "#FFF", text: "#111" } } })]);
    await api.styleguide({ domain: "acme.com" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.context.dev/v1/web/styleguide?domain=acme.com");
  });

  // A half-answered styleguide is still worth having: the palette step drops
  // whatever does not parse as a hex rather than the whole call.
  it("blanks a colour the response left out instead of failing the call", async () => {
    const { api } = client([json({ styleguide: { colors: { accent: "#1A73E8" } } })]);
    await expect(api.styleguide({ domain: "acme.com" })).resolves.toMatchObject({
      colors: { accent: "#1A73E8", background: "", text: "" },
    });
  });
});

describe("fonts", () => {
  it("returns the faces in usage order with the primary first", async () => {
    const { api, fetchImpl } = client([json({
      status: "ok",
      domain: "acme.com",
      fonts: [
        { font: "Inter", uses: ["body", "h1"], fallbacks: ["sans-serif"], num_elements: 120, num_words: 900, percent_words: 82.5, percent_elements: 74 },
        { font: "Georgia", uses: ["blockquote"], fallbacks: ["serif"], num_elements: 3, num_words: 40, percent_words: 3.5, percent_elements: 2 },
      ],
      fontLinks: { Inter: { type: "google", files: { "400": "https://fonts.gstatic.com/i.woff2" } } },
    })]);

    const result = await api.fonts({ domain: "acme.com" });

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.context.dev/v1/web/fonts?domain=acme.com");
    expect(result.fonts.map((entry) => entry.font)).toEqual(["Inter", "Georgia"]);
    expect(result.fonts[0]).toEqual({
      font: "Inter",
      uses: ["body", "h1"],
      fallbacks: ["sans-serif"],
      percent_words: 82.5,
      percent_elements: 74,
    });
    expect(result.fontLinks?.Inter?.type).toBe("google");
  });

  // fontLinks is omitted whenever nothing resolves to a Google/@font-face file.
  it("tolerates a response with no fontLinks", async () => {
    const { api } = client([json({ fonts: [{ font: "Helvetica", uses: [], fallbacks: [] }] })]);
    const result = await api.fonts({ domain: "acme.com" });
    expect(result.fontLinks).toBeUndefined();
    expect(result.fonts[0]).toMatchObject({ font: "Helvetica", percent_words: 0, percent_elements: 0 });
  });
});

describe("scrapeMarkdown", () => {
  it("scrapes the URL and can ask for main content only", async () => {
    const { api, fetchImpl } = client([json({
      success: true,
      markdown: "# Acme\n\nThings, done.",
      contentLength: 21,
      url: "https://acme.com/",
      metadata: { sourceUrl: "https://acme.com", finalUrl: "https://acme.com/", title: "Acme", siteName: "Acme" },
    })]);

    const result = await api.scrapeMarkdown({ url: "https://acme.com", useMainContentOnly: true });

    expect(fetchImpl.mock.calls[0]![0])
      .toBe("https://api.context.dev/v1/web/scrape/markdown?url=https%3A%2F%2Facme.com&useMainContentOnly=true");
    expect(result.markdown).toContain("# Acme");
    expect(result.metadata?.title).toBe("Acme");
  });

  // The published example omits `metadata` even though the schema requires it.
  it("tolerates a response with no metadata", async () => {
    const { api } = client([json({ success: true, markdown: "hello", contentLength: 5, url: "https://acme.com/" })]);
    const result = await api.scrapeMarkdown({ url: "https://acme.com" });
    expect(result.markdown).toBe("hello");
    expect(result.metadata).toBeUndefined();
  });
});

describe("domainFromUrl", () => {
  it("strips scheme, path and www so the domain-keyed endpoints accept it", () => {
    expect(domainFromUrl("https://www.Acme.com/pricing?ref=1")).toBe("acme.com");
    expect(domainFromUrl("acme.com")).toBe("acme.com");
    expect(domainFromUrl("http://app.acme.co.uk")).toBe("app.acme.co.uk");
  });

  it("returns nothing for input the API's 3-character minimum would reject", () => {
    expect(domainFromUrl("")).toBeUndefined();
    expect(domainFromUrl("ab")).toBeUndefined();
    expect(domainFromUrl("https://")).toBeUndefined();
  });
});
