/**
 * The default-model resolver: one function feeds the lanes and the CLI
 * summary line, so what ran is always what is reported. The Gemini fallback
 * only engages when the Anthropic key is absent AND both Gemini vars are
 * present; GENUI_BENCH_MODEL beats everything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_MODEL, defaultModelId, providerKeyFor } from "./models";

afterEach(() => {
  vi.unstubAllEnvs();
});

const clearModelEnv = () => {
  vi.stubEnv("GENUI_BENCH_MODEL", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_MODEL", "");
};

describe("defaultModelId", () => {
  it("is the engine default when nothing overrides", () => {
    clearModelEnv();
    expect(defaultModelId()).toBe(PRODUCTION_MODEL.id);
  });

  it("GENUI_BENCH_MODEL beats everything", () => {
    clearModelEnv();
    vi.stubEnv("GENUI_BENCH_MODEL", "claude-opus-5");
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
    expect(defaultModelId()).toBe("claude-opus-5");
  });

  it("falls back to the root .env Gemini model only when the Anthropic key is absent", () => {
    clearModelEnv();
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
    expect(defaultModelId()).toBe("gemini-2.5-flash");
    vi.stubEnv("ANTHROPIC_API_KEY", "k2");
    expect(defaultModelId()).toBe(PRODUCTION_MODEL.id);
  });

  it("does not fall back on a Gemini key without a model id (or vice versa)", () => {
    clearModelEnv();
    vi.stubEnv("GEMINI_API_KEY", "k");
    expect(defaultModelId()).toBe(PRODUCTION_MODEL.id);
    clearModelEnv();
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
    expect(defaultModelId()).toBe(PRODUCTION_MODEL.id);
  });
});

describe("providerKeyFor", () => {
  it("routes gemini ids to the Gemini key and everything else to Anthropic", () => {
    expect(providerKeyFor("gemini-2.5-flash")).toBe("GEMINI_API_KEY");
    expect(providerKeyFor("claude-sonnet-4-6")).toBe("ANTHROPIC_API_KEY");
  });
});
