/**
 * The context.dev client the evidence stage runs on — plain `fetch`, no SDK,
 * no new dependency.
 *
 * Four calls carry the whole brand evidence budget:
 *   POST /brand/retrieve      → the logo files and the logo-extracted palette
 *   GET  /web/styleguide      → the colours/type/components AS RENDERED on the
 *                               site (better fidelity than logo extraction —
 *                               there is no /brand/colors endpoint)
 *   GET  /web/fonts           → which faces actually carry the page, by usage
 *   GET  /web/scrape/markdown → the site's own words, for voice and vocabulary
 *
 * The OpenAPI spec marks almost nothing inside these payloads as required, so
 * every field is narrowed defensively: a half-answered response is normal and
 * must still be usable. Each result also carries the verbatim body on `raw`,
 * which the evidence stage writes to RESEARCH/context-dev/ — the narrowing is
 * deliberately lossy and that file is the backstop when a human debugs
 * fidelity later.
 */

const defaultBaseUrl = "https://api.context.dev/v1";

/** A cold /brand/retrieve takes ~7s live; a tight timeout turns a working call
 * into a soft failure and a demo with no logo. */
const defaultTimeoutMs = 45_000;

export interface BrandColor {
  hex: string;
  name?: string;
}

export interface BrandLogo {
  url: string;
  mode?: "light" | "dark" | "has_opaque_background";
  type?: "icon" | "logo";
  resolution?: { width: number; height: number; aspect_ratio: number };
}

export interface BrandRetrieveResult {
  title?: string;
  description?: string;
  slogan?: string;
  domain?: string;
  /** Ordered by prominence — index 0 is the primary brand colour. */
  colors: BrandColor[];
  logos: BrandLogo[];
  /** Verbatim response body (persisted to RESEARCH/, dropped from the digest). */
  raw?: unknown;
}

export interface StyleguideTextStyle {
  fontFamily?: string;
  fontFallbacks?: string[];
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
}

export interface FontLink {
  type: string;
  category?: string;
  files: Record<string, string>;
}

export interface StyleguideResult {
  mode?: string;
  colors: { accent: string; background: string; text: string };
  typography?: { headings?: Record<string, StyleguideTextStyle>; p?: StyleguideTextStyle };
  elementSpacing?: Record<string, string>;
  shadows?: Record<string, string>;
  fontLinks?: Record<string, FontLink>;
  /** Every component field the API documents is a CSS value (backgroundColor,
   * borderRadius, padding, the raw `css` blob), so they are kept as strings —
   * the brief reads them straight into theme tokens. */
  components?: { button?: Record<string, Record<string, string>>; card?: Record<string, string> };
  raw?: unknown;
}

export interface FontUsage {
  font: string;
  uses: string[];
  fallbacks: string[];
  percent_elements: number;
  percent_words: number;
}

export interface FontsResult {
  /** Ordered by usage — index 0 is the face that carries the page. */
  fonts: FontUsage[];
  fontLinks?: Record<string, FontLink>;
  raw?: unknown;
}

export interface MarkdownResult {
  markdown: string;
  /** UTF-8 byte length, as the API reports it. */
  contentLength: number;
  url: string;
  metadata?: { title?: string; description?: string; siteName?: string };
  raw?: unknown;
}

/** A non-2xx from context.dev, carrying enough to write an error envelope to
 * RESEARCH/ — and never the API key. */
export class ContextDevError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly errorCode?: string;

  constructor(options: { status: number; endpoint: string; message: string; errorCode?: string }) {
    super(`context.dev ${options.endpoint} failed (HTTP ${options.status}): ${options.message}`);
    this.name = "ContextDevError";
    this.status = options.status;
    this.endpoint = options.endpoint;
    if (options.errorCode !== undefined) this.errorCode = options.errorCode;
  }
}

export interface ContextDevClient {
  retrieveBrand(input: { domain: string } | { name: string }): Promise<BrandRetrieveResult>;
  styleguide(input: { domain: string; colorScheme?: "light" | "dark" }): Promise<StyleguideResult>;
  fonts(input: { domain: string }): Promise<FontsResult>;
  scrapeMarkdown(input: { url: string; useMainContentOnly?: boolean }): Promise<MarkdownResult>;
}

export interface ContextDevOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// narrowing helpers (hand-written: bench has no schema validator, and one
// endpoint family does not justify adding one)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** CSS-ish values arrive as either `"700"` or `700`; the brief reads strings. */
function asCssValue(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  return typeof value === "number" ? String(value) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const css = asCssValue(entry);
    if (css !== undefined) out[key] = css;
  }
  return out;
}

function narrowTextStyle(value: unknown): StyleguideTextStyle | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const fontFamily = asString(record.fontFamily);
  const fontFallbacks = asStringArray(record.fontFallbacks);
  const fontSize = asCssValue(record.fontSize);
  const fontWeight = asCssValue(record.fontWeight);
  const lineHeight = asCssValue(record.lineHeight);
  const letterSpacing = asCssValue(record.letterSpacing);
  return {
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(fontFallbacks.length === 0 ? {} : { fontFallbacks }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(fontWeight === undefined ? {} : { fontWeight }),
    ...(lineHeight === undefined ? {} : { lineHeight }),
    ...(letterSpacing === undefined ? {} : { letterSpacing }),
  };
}

function narrowFontLinks(value: unknown): Record<string, FontLink> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const out: Record<string, FontLink> = {};
  for (const [family, entry] of Object.entries(record)) {
    const link = asRecord(entry);
    const type = asString(link?.type);
    if (link === undefined || type === undefined) continue;
    const category = asString(link.category);
    out[family] = {
      type,
      ...(category === undefined ? {} : { category }),
      files: asStringRecord(link.files) ?? {},
    };
  }
  return out;
}

const logoModes = new Set(["light", "dark", "has_opaque_background"]);

function narrowLogos(value: unknown): BrandLogo[] {
  if (!Array.isArray(value)) return [];
  const logos: BrandLogo[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const url = asString(record?.url);
    if (record === undefined || url === undefined) continue;
    const mode = asString(record.mode);
    const type = asString(record.type);
    const resolution = asRecord(record.resolution);
    const width = asNumber(resolution?.width);
    const height = asNumber(resolution?.height);
    logos.push({
      url,
      ...(mode !== undefined && logoModes.has(mode) ? { mode: mode as BrandLogo["mode"] } : {}),
      ...(type === "icon" || type === "logo" ? { type } : {}),
      ...(width === undefined || height === undefined
        ? {}
        : { resolution: { width, height, aspect_ratio: asNumber(resolution?.aspect_ratio) ?? width / height } }),
    });
  }
  return logos;
}

function narrowColors(value: unknown): BrandColor[] {
  if (!Array.isArray(value)) return [];
  const colors: BrandColor[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const hex = asString(record?.hex);
    if (hex === undefined) continue;
    const name = asString(record?.name);
    colors.push({ hex, ...(name === undefined ? {} : { name }) });
  }
  return colors;
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/** `{ message: string | {code,message,path}[], status, error_code }` — and 429
 * spells the code `code` instead. */
function envelopeMessage(body: unknown): string {
  const message = asRecord(body)?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    const issues = message.map((entry) => {
      const issue = asRecord(entry);
      const text = asString(issue?.message) ?? "invalid";
      const at = Array.isArray(issue?.path) ? issue.path.join(".") : asString(issue?.path);
      return at === undefined || at === "" ? text : `${at}: ${text}`;
    });
    if (issues.length > 0) return issues.join("; ");
  }
  return "no message in the response body";
}

function envelopeCode(body: unknown): string | undefined {
  const record = asRecord(body);
  return asString(record?.error_code) ?? asString(record?.code);
}

async function request(options: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  apiKey: string;
  endpoint: string;
  url: string;
  body?: unknown;
}): Promise<unknown> {
  const response = await options.fetchImpl(options.url, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const code = envelopeCode(parsed);
    throw new ContextDevError({
      status: response.status,
      endpoint: options.endpoint,
      message: parsed === undefined ? "response body was not JSON" : envelopeMessage(parsed),
      ...(code === undefined ? {} : { errorCode: code }),
    });
  }
  if (parsed === undefined) {
    throw new ContextDevError({ status: response.status, endpoint: options.endpoint, message: "response body was not JSON" });
  }
  return parsed;
}

function requireApiKey(explicit: string | undefined): string {
  const key = (explicit ?? process.env.CONTEXT_DEV_API_KEY ?? "").trim();
  if (key === "") {
    throw new Error(
      "CONTEXT_DEV_API_KEY is not set, so the brand evidence calls cannot run. " +
        "The key lives in Infisical; export it into this shell before running demo:pipeline.",
    );
  }
  return key;
}

/** Strips scheme/path/www from a URL so the domain-keyed endpoints accept it. */
export function domainFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return undefined;
  }
  const bare = hostname.replace(/^www\./i, "").toLowerCase();
  // The API enforces minLength 3; sending less just buys a 400.
  return bare.length >= 3 ? bare : undefined;
}

export function createContextDevClient(options: ContextDevOptions = {}): ContextDevClient {
  const apiKey = requireApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const send = (endpoint: string, url: string, body?: unknown): Promise<unknown> =>
    request({ fetchImpl, timeoutMs, apiKey, endpoint, url, ...(body === undefined ? {} : { body }) });

  return {
    async retrieveBrand(input) {
      const body = "domain" in input ? { type: "by_domain", domain: input.domain } : { type: "by_name", name: input.name };
      const payload = await send("POST /brand/retrieve", `${baseUrl}/brand/retrieve`, body);
      const brand = asRecord(asRecord(payload)?.brand) ?? {};
      const title = asString(brand.title);
      const description = asString(brand.description);
      const slogan = asString(brand.slogan);
      const domain = asString(brand.domain);
      return {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(slogan === undefined ? {} : { slogan }),
        ...(domain === undefined ? {} : { domain }),
        colors: narrowColors(brand.colors),
        logos: narrowLogos(brand.logos),
        raw: payload,
      };
    },

    async styleguide(input) {
      const query = new URLSearchParams({ domain: input.domain });
      if (input.colorScheme !== undefined) query.set("colorScheme", input.colorScheme);
      const payload = await send("GET /web/styleguide", `${baseUrl}/web/styleguide?${query.toString()}`);
      const styleguide = asRecord(asRecord(payload)?.styleguide) ?? {};
      const colors = asRecord(styleguide.colors) ?? {};
      const mode = asString(styleguide.mode);
      const headings = asRecord(asRecord(styleguide.typography)?.headings);
      const paragraph = narrowTextStyle(asRecord(styleguide.typography)?.p);
      const narrowedHeadings: Record<string, StyleguideTextStyle> = {};
      for (const [level, style] of Object.entries(headings ?? {})) {
        const narrowed = narrowTextStyle(style);
        if (narrowed !== undefined) narrowedHeadings[level] = narrowed;
      }
      const elementSpacing = asStringRecord(styleguide.elementSpacing);
      const shadows = asStringRecord(styleguide.shadows);
      const fontLinks = narrowFontLinks(styleguide.fontLinks);
      const components = asRecord(styleguide.components);
      const button = asRecord(components?.button);
      const card = asStringRecord(components?.card);
      const narrowedButtons: Record<string, Record<string, string>> = {};
      for (const [variant, style] of Object.entries(button ?? {})) {
        const record = asStringRecord(style);
        if (record !== undefined) narrowedButtons[variant] = record;
      }
      return {
        ...(mode === undefined ? {} : { mode }),
        // A colour the response left out becomes "" rather than failing the
        // call: two thirds of a rendered palette still beats none of it, and
        // the palette step drops whatever does not parse as a hex.
        colors: {
          accent: asString(colors.accent) ?? "",
          background: asString(colors.background) ?? "",
          text: asString(colors.text) ?? "",
        },
        ...(Object.keys(narrowedHeadings).length === 0 && paragraph === undefined
          ? {}
          : {
              typography: {
                ...(Object.keys(narrowedHeadings).length === 0 ? {} : { headings: narrowedHeadings }),
                ...(paragraph === undefined ? {} : { p: paragraph }),
              },
            }),
        ...(elementSpacing === undefined ? {} : { elementSpacing }),
        ...(shadows === undefined ? {} : { shadows }),
        ...(fontLinks === undefined ? {} : { fontLinks }),
        ...(components === undefined
          ? {}
          : {
              components: {
                ...(Object.keys(narrowedButtons).length === 0 ? {} : { button: narrowedButtons }),
                ...(card === undefined ? {} : { card }),
              },
            }),
        raw: payload,
      };
    },

    async fonts(input) {
      const query = new URLSearchParams({ domain: input.domain });
      const payload = await send("GET /web/fonts", `${baseUrl}/web/fonts?${query.toString()}`);
      const rawFonts = asRecord(payload)?.fonts;
      const faces: FontUsage[] = [];
      for (const entry of Array.isArray(rawFonts) ? rawFonts : []) {
        const record = asRecord(entry);
        const font = asString(record?.font);
        if (record === undefined || font === undefined) continue;
        faces.push({
          font,
          uses: asStringArray(record.uses),
          fallbacks: asStringArray(record.fallbacks),
          percent_elements: asNumber(record.percent_elements) ?? 0,
          percent_words: asNumber(record.percent_words) ?? 0,
        });
      }
      const fontLinks = narrowFontLinks(asRecord(payload)?.fontLinks);
      return { fonts: faces, ...(fontLinks === undefined ? {} : { fontLinks }), raw: payload };
    },

    async scrapeMarkdown(input) {
      const query = new URLSearchParams({ url: input.url });
      if (input.useMainContentOnly === true) query.set("useMainContentOnly", "true");
      const payload = await send("GET /web/scrape/markdown", `${baseUrl}/web/scrape/markdown?${query.toString()}`);
      const record = asRecord(payload) ?? {};
      const markdown = typeof record.markdown === "string" ? record.markdown : "";
      // The published example omits `metadata` even though the schema requires
      // it, so its absence is a normal response, not a broken one.
      const metadata = asRecord(record.metadata);
      const title = asString(metadata?.title);
      const description = asString(metadata?.description);
      const siteName = asString(metadata?.siteName);
      const hasMetadata = title !== undefined || description !== undefined || siteName !== undefined;
      return {
        markdown,
        contentLength: asNumber(record.contentLength) ?? Buffer.byteLength(markdown, "utf8"),
        url: asString(record.url) ?? input.url,
        ...(hasMetadata
          ? {
              metadata: {
                ...(title === undefined ? {} : { title }),
                ...(description === undefined ? {} : { description }),
                ...(siteName === undefined ? {} : { siteName }),
              },
            }
          : {}),
        raw: payload,
      };
    },
  };
}
