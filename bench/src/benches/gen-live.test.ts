import { describe, expect, it } from "vitest";
import { missingCreateTotalError } from "./gen-live.js";
import type { CaseResult } from "../types.js";

const metric = (name: string): CaseResult => ({
  name,
  unit: "ms",
  samples: 3,
  p50: 900,
  p95: 950,
  min: 880,
  max: 960,
});

describe("missingCreateTotalError", () => {
  it("returns undefined when a create-total case exists (primary model)", () => {
    const cases = [metric("stream-ttfb (claude-sonnet-5)"), metric("create-total (claude-sonnet-5)")];
    expect(missingCreateTotalError(cases, [])).toBeUndefined();
  });

  it("returns undefined when only the fallback model produced create-total", () => {
    const cases = [metric("stream-ttfb (claude-sonnet-5)"), metric("create-total (claude-haiku-4-5)")];
    expect(missingCreateTotalError(cases, ["create() on claude-sonnet-5 failed: 400"])).toBeUndefined();
  });

  it("returns an Error when no create-total case was produced", () => {
    const error = missingCreateTotalError(
      [metric("stream-ttfb (claude-sonnet-5)"), metric("stream-total (claude-sonnet-5)")],
      ["create() on claude-sonnet-5 failed: boom", "create() on claude-haiku-4-5 also failed: boom"],
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("no create-total metric");
    expect(error!.message).toContain("claude-sonnet-5 failed: boom");
    expect(error!.message).toContain("claude-haiku-4-5 also failed: boom");
  });

  it("folds successful stream measurements into the error message", () => {
    const error = missingCreateTotalError(
      [metric("stream-ttfb (claude-sonnet-5)")],
      ["create() on claude-sonnet-5 failed: boom"],
    );
    expect(error!.message).toContain("successful stream measurements");
    expect(error!.message).toContain("stream-ttfb (claude-sonnet-5): p50=900ms p95=950ms (n=3)");
  });

  it("errors with no stream context when even streaming produced nothing", () => {
    const error = missingCreateTotalError([], ["create() failed before streaming"]);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain("successful stream measurements");
  });
});
