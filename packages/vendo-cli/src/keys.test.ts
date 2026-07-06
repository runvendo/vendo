import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("returns invalid with a reason when the call fails (e.g. 401)", async () => {
    const model = throwingModel("401 Unauthorized");
    const result = await validateKey("anthropic", "sk-ant-bad", { model });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toMatch(/401/);
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
