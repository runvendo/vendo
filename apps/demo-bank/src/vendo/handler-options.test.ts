import { describe, it, expect, afterEach, vi } from "vitest";
import { detectCapabilities } from "vendoai/server";

const savedKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  vi.resetModules();
});

// `vendoOptions.model` is assembled once at module-load time (see
// handler-options.ts's own comment on why it's a shared singleton), so
// exercising both env states means resetting the module registry and
// re-importing between assertions.
describe("vendoOptions keyless boot", () => {
  it("does not inject a model when ANTHROPIC_API_KEY is unset, so chat reports false", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const { vendoOptions } = await import("./handler-options");
    expect(vendoOptions.model).toBeUndefined();
    expect(
      detectCapabilities(process.env, { hasInjectedModel: vendoOptions.model !== undefined }).chat,
    ).toBe(false);
  });

  it("injects a model when ANTHROPIC_API_KEY is set, so chat reports true", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    vi.resetModules();
    const { vendoOptions } = await import("./handler-options");
    expect(vendoOptions.model).toBeDefined();
    expect(
      detectCapabilities(process.env, { hasInjectedModel: vendoOptions.model !== undefined }).chat,
    ).toBe(true);
  });
});
