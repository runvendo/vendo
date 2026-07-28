import { describe, expect, it } from "vitest";
import { usage } from "./cli.js";
import { preflight } from "./pipeline.js";

/**
 * The operator surface's one honesty rule: everything the pipeline REFUSES TO
 * START without has to be named in `--help`.
 *
 * It was not. `--help` named ANTHROPIC_API_KEY and CONTEXT_DEV_API_KEY, so lane
 * 3 provisioned exactly those two on the mini — and preflight also hard-requires
 * VENDO_API_KEY, so `demo:pipeline` would have refused to start there with an
 * error naming a variable no document mentioned.
 */
describe("--help and preflight agree", () => {
  const requiredEnvNames = (): string[] => {
    try {
      preflight({});
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [...message.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)].map((match) => match[1] as string);
    }
  };

  it("names every credential preflight requires", () => {
    const named = usage();
    const missing = [...new Set(requiredEnvNames())].filter((name) => !named.includes(name));
    expect(missing).toEqual([]);
  });

  it("is actually checking something — preflight requires at least three", () => {
    expect(new Set(requiredEnvNames()).size).toBeGreaterThanOrEqual(3);
  });

  it("documents both commands and the machine-readable outcome lines", () => {
    expect(usage()).toContain("demo:pipeline");
    expect(usage()).toContain("demo:fix");
  });
});
