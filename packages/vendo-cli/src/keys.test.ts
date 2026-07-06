import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  appendProviderKey,
  detectProvider,
  PROVIDER_ENV_VAR,
  validateKey,
  type ModelProvider,
} from "./keys.js";
import { textModel, throwingModel } from "./test-helpers.js";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "vendo-cli-keys-"));
}

/** A mock model whose generate call fails with a real provider-shaped
 *  `APICallError` carrying the given HTTP status — what the AI SDK actually
 *  throws for 401/403/429/5xx responses. */
function apiErrorModel(statusCode: number, message: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new APICallError({
        message,
        url: "https://api.example.test/v1/messages",
        requestBodyValues: {},
        statusCode,
        isRetryable: statusCode === 429 || statusCode >= 500,
      });
    },
  });
}

describe("detectProvider", () => {
  const cases: Array<[string, ModelProvider | null]> = [
    ["sk-ant-api03-abc123", "anthropic"],
    ["sk-ant-", "anthropic"],
    ["sk-proj-abc123", "openai"],
    ["sk-abc123", "openai"],
    ["AIzaSyAbc123", "google"],
    ["not-a-real-key", null],
    ["", null],
  ];

  it.each(cases)("detects %s as %s", (key, expected) => {
    expect(detectProvider(key)).toBe(expected);
  });

  it("checks sk-ant- before the generic sk- prefix (order matters)", () => {
    // If this were checked in the wrong order, an Anthropic key would be
    // misdetected as OpenAI since "sk-ant-..." also starts with "sk-".
    expect(detectProvider("sk-ant-should-not-be-openai")).toBe("anthropic");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(detectProvider("  sk-ant-x  ")).toBe("anthropic");
  });
});

describe("PROVIDER_ENV_VAR", () => {
  it("matches the env vars llm.ts/resolveModel already read", () => {
    expect(PROVIDER_ENV_VAR).toEqual({
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
    });
  });
});

describe("validateKey", () => {
  it("returns valid when the one-token generate call succeeds (injected model, no network)", async () => {
    const model = textModel(["ok"]);
    const result = await validateKey("anthropic", "sk-ant-x", { model });
    expect(result).toEqual({ status: "valid" });
  });

  it("returns invalid when the provider rejects the credential (401)", async () => {
    const model = apiErrorModel(401, "invalid x-api-key");
    const result = await validateKey("anthropic", "sk-ant-bad", { model });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toMatch(/invalid x-api-key/);
  });

  it("returns invalid on 403 (credential rejected, not a connectivity problem)", async () => {
    const model = apiErrorModel(403, "forbidden");
    const result = await validateKey("openai", "sk-revoked", { model });
    expect(result.status).toBe("invalid");
  });

  it("returns unreachable (NOT invalid) on 429 — rate limiting says nothing about the key", async () => {
    const model = apiErrorModel(429, "rate limit exceeded");
    const result = await validateKey("anthropic", "sk-ant-x", { model });
    expect(result.status).toBe("unreachable");
    expect(result.status === "unreachable" && result.reason).toMatch(/could not reach Anthropic.*retry/);
  });

  it("returns unreachable on a 500 server error", async () => {
    const model = apiErrorModel(500, "internal server error");
    const result = await validateKey("google", "AIzaX", { model });
    expect(result.status).toBe("unreachable");
    expect(result.status === "unreachable" && result.reason).toContain("Google");
  });

  it("returns unreachable on a plain network error (offline/DNS — no HTTP status at all)", async () => {
    const model = throwingModel("fetch failed");
    const result = await validateKey("openai", "sk-x", { model });
    expect(result.status).toBe("unreachable");
    expect(result.status === "unreachable" && result.reason).toMatch(/could not reach OpenAI.*check your connection and retry/);
  });

  it("aborts a hanging call after timeoutMs and reports unreachable", async () => {
    const hanging = new MockLanguageModelV3({
      doGenerate: (opts) =>
        new Promise((_, reject) => {
          // A well-behaved provider transport rejects when the signal fires;
          // never resolves otherwise.
          opts.abortSignal?.addEventListener("abort", () => reject(opts.abortSignal?.reason ?? new Error("aborted")));
        }),
    });
    const result = await validateKey("anthropic", "sk-ant-x", { model: hanging, timeoutMs: 25 });
    expect(result.status).toBe("unreachable");
  });

  it("returns unavailable (not invalid) when the optional provider package can't be imported", async () => {
    const importer = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-sdk/openai'");
    });
    const result = await validateKey("openai", "sk-x", { import: importer });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toContain("@ai-sdk/openai");
    expect(importer).toHaveBeenCalledWith("@ai-sdk/openai");
  });

  it("returns unavailable when the optional peer resolves but doesn't export the expected factory", async () => {
    const importer = vi.fn(async () => ({ notTheRightExport: () => {} }));
    const result = await validateKey("google", "AIzaX", { import: importer });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toContain("@ai-sdk/google");
  });

  it("builds the optional provider model from the dynamically imported factory and validates with it", async () => {
    const fakeModel = textModel(["ok"]);
    const factory = vi.fn(() => fakeModel);
    const creator = vi.fn(() => factory);
    const importer = vi.fn(async () => ({ createGoogleGenerativeAI: creator }));
    const result = await validateKey("google", "AIzaX", { import: importer });
    expect(result).toEqual({ status: "valid" });
    expect(creator).toHaveBeenCalledWith({ apiKey: "AIzaX" });
  });

  it("never logs or echoes the raw key value", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = throwingModel("401 Unauthorized: bad credentials");
    const secret = "sk-ant-super-secret-value";
    await validateKey("anthropic", secret, { model });
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain(secret);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("appendProviderKey", () => {
  it("creates .env.local when absent", async () => {
    const dir = await scratch();
    const result = await appendProviderKey(dir, "anthropic", "sk-ant-abc");
    expect(result.created).toBe(true);
    const content = await readFile(result.file, "utf8");
    expect(content).toBe("\n# added by vendo init\nANTHROPIC_API_KEY=sk-ant-abc\n");
  });

  it("preserves existing content byte-for-byte and appends after a trailing newline", async () => {
    const dir = await scratch();
    const file = path.join(dir, ".env.local");
    await writeFile(file, "EXISTING=1\n");
    const result = await appendProviderKey(dir, "openai", "sk-x");
    expect(result.created).toBe(false);
    const content = await readFile(file, "utf8");
    expect(content).toBe("EXISTING=1\n\n# added by vendo init\nOPENAI_API_KEY=sk-x\n");
    expect(content.startsWith("EXISTING=1\n")).toBe(true);
  });

  it("adds exactly one newline boundary when the existing file has no trailing newline", async () => {
    const dir = await scratch();
    const file = path.join(dir, ".env.local");
    await writeFile(file, "EXISTING=1");
    await appendProviderKey(dir, "google", "AIzaX");
    const content = await readFile(file, "utf8");
    expect(content).toBe("EXISTING=1\n\n# added by vendo init\nGOOGLE_GENERATIVE_AI_API_KEY=AIzaX\n");
  });

  it("creates .env.local owner-only (0600) since it holds a credential", async () => {
    const dir = await scratch();
    const result = await appendProviderKey(dir, "anthropic", "sk-ant-abc");
    expect(result.created).toBe(true);
    const { mode } = await stat(result.file);
    expect(mode & 0o777).toBe(0o600);
  });

  it("leaves an existing .env.local's permissions untouched (append-only, it's the user's file)", async () => {
    const dir = await scratch();
    const file = path.join(dir, ".env.local");
    await writeFile(file, "EXISTING=1\n", { mode: 0o644 });
    await appendProviderKey(dir, "openai", "sk-x");
    const { mode } = await stat(file);
    expect(mode & 0o777).toBe(0o644);
  });

  it("never logs or echoes the raw key value while appending", async () => {
    const dir = await scratch();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "sk-ant-super-secret-append";
    await appendProviderKey(dir, "anthropic", secret);
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain(secret);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
