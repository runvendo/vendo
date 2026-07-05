import { describe, it, expect } from "vitest";
import type { PolicyContext } from "./types.js";
import type { ToolAnnotations } from "../descriptor.js";
import { annotationPolicy } from "./annotation.js";

/** Build a minimal PolicyContext with the given annotations under test. */
function ctx(annotations: ToolAnnotations): PolicyContext {
  return {
    toolName: "testTool",
    input: {},
    descriptor: {
      name: "testTool",
      source: "engine",
      annotations,
      hasExecute: true,
      kind: "function",
    },
    principal: { userId: "u1" },
  };
}

describe("annotationPolicy", () => {
  it("returns 'allow' when readOnlyHint is true", async () => {
    const policy = annotationPolicy();
    expect(await policy.evaluate(ctx({ readOnlyHint: true }))).toBe("allow");
  });

  it("returns 'approve' when destructiveHint is true", async () => {
    const policy = annotationPolicy();
    expect(await policy.evaluate(ctx({ destructiveHint: true }))).toBe("approve");
  });

  it("returns 'approve' when openWorldHint is true", async () => {
    const policy = annotationPolicy();
    expect(await policy.evaluate(ctx({ openWorldHint: true }))).toBe("approve");
  });

  it("returns 'approve' when no hints are set (fail-safe default)", async () => {
    const policy = annotationPolicy();
    expect(await policy.evaluate(ctx({}))).toBe("approve");
  });

  it("returns 'approve' when both readOnlyHint and destructiveHint are true (destructive wins)", async () => {
    const policy = annotationPolicy();
    expect(
      await policy.evaluate(ctx({ readOnlyHint: true, destructiveHint: true })),
    ).toBe("approve");
  });
});
