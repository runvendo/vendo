import { describe, it, expect } from "vitest";
import { FlowletError, policyDenied } from "./errors";

describe("FlowletError", () => {
  it("carries the given code and message", () => {
    const err = new FlowletError("auth", "unauthorized");
    expect(err.code).toBe("auth");
    expect(err.message).toBe("unauthorized");
  });

  it("is an instanceof Error", () => {
    const err = new FlowletError("tool", "tool failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name === 'FlowletError'", () => {
    const err = new FlowletError("policy", "denied");
    expect(err.name).toBe("FlowletError");
  });
});

describe("policyDenied", () => {
  it("returns the exact structured payload", () => {
    const result = policyDenied("sendMoney", "no transfers over $500");
    expect(result).toEqual({
      code: "policy_denied",
      tool: "sendMoney",
      rule: "no transfers over $500",
    });
  });

  it("is a plain object, not an Error", () => {
    const result = policyDenied("sendMoney", "no transfers over $500");
    expect(result).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
