import { describe, it, expect } from "vitest";
import type { PolicyContext } from "./types";
import { thresholdRule, roleRule } from "./principal-rules";

/** Build a minimal PolicyContext for principal-rules tests. */
function ctx(
  input: unknown,
  principal: { userId: string; roles?: string[]; limits?: Record<string, number> },
): PolicyContext {
  return {
    toolName: "testTool",
    input,
    descriptor: {
      name: "testTool",
      source: "engine",
      annotations: {},
      hasExecute: true,
      kind: "function",
    },
    principal,
  };
}

describe("thresholdRule", () => {
  it("returns 'approve' when value exceeds the principal limit", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({ amount: 1500 }, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("approve");
  });

  it("returns 'allow' when value equals the limit (not over)", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({ amount: 1000 }, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when value is under the limit", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({ amount: 500 }, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when limit is undefined (no gating)", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({ amount: 99999 }, { userId: "u1" }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when arg is missing from input", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({}, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when arg value is non-numeric", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx({ amount: "lots" }, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when input is non-object (null)", async () => {
    const policy = thresholdRule({ argPath: "amount", limitKey: "maxAmount" });
    const result = await policy.evaluate(
      ctx(null, { userId: "u1", limits: { maxAmount: 1000 } }),
    );
    expect(result).toBe("allow");
  });

  it("reads nested dot-path correctly and returns 'approve' when over limit", async () => {
    const policy = thresholdRule({ argPath: "transfer.usd", limitKey: "maxTransfer" });
    const result = await policy.evaluate(
      ctx({ transfer: { usd: 5000 } }, { userId: "u1", limits: { maxTransfer: 2000 } }),
    );
    expect(result).toBe("approve");
  });

  it("reads nested dot-path correctly and returns 'allow' when under limit", async () => {
    const policy = thresholdRule({ argPath: "transfer.usd", limitKey: "maxTransfer" });
    const result = await policy.evaluate(
      ctx({ transfer: { usd: 100 } }, { userId: "u1", limits: { maxTransfer: 2000 } }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when nested path is partially missing", async () => {
    const policy = thresholdRule({ argPath: "transfer.usd", limitKey: "maxTransfer" });
    const result = await policy.evaluate(
      ctx({ transfer: {} }, { userId: "u1", limits: { maxTransfer: 2000 } }),
    );
    expect(result).toBe("allow");
  });
});

describe("roleRule", () => {
  it("returns 'deny' when principal has no roles", async () => {
    const policy = roleRule({ requiredRole: "admin" });
    const result = await policy.evaluate(ctx({}, { userId: "u1" }));
    expect(result).toBe("deny");
  });

  it("returns 'deny' when principal roles does not include required role", async () => {
    const policy = roleRule({ requiredRole: "admin" });
    const result = await policy.evaluate(
      ctx({}, { userId: "u1", roles: ["viewer", "editor"] }),
    );
    expect(result).toBe("deny");
  });

  it("returns 'allow' when principal has the required role", async () => {
    const policy = roleRule({ requiredRole: "admin" });
    const result = await policy.evaluate(
      ctx({}, { userId: "u1", roles: ["admin", "viewer"] }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'allow' when principal has exactly the required role", async () => {
    const policy = roleRule({ requiredRole: "editor" });
    const result = await policy.evaluate(
      ctx({}, { userId: "u1", roles: ["editor"] }),
    );
    expect(result).toBe("allow");
  });

  it("returns 'deny' when roles is an empty array", async () => {
    const policy = roleRule({ requiredRole: "admin" });
    const result = await policy.evaluate(
      ctx({}, { userId: "u1", roles: [] }),
    );
    expect(result).toBe("deny");
  });
});
