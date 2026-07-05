import { describe, it, expect } from "vitest";
import { VendoError, policyDenied, approvalRequired } from "./errors.js";

describe("VendoError", () => {
  it("carries the given code and message", () => {
    const err = new VendoError("auth", "unauthorized");
    expect(err.code).toBe("auth");
    expect(err.message).toBe("unauthorized");
  });

  it("is an instanceof Error", () => {
    const err = new VendoError("tool", "tool failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name === 'VendoError'", () => {
    const err = new VendoError("policy", "denied");
    expect(err.name).toBe("VendoError");
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

describe("approvalRequired", () => {
  it("returns the exact structured payload, with a code distinct from policy_denied", () => {
    const result = approvalRequired("sendMoney", "ask the user again");
    expect(result).toEqual({
      code: "approval_required",
      tool: "sendMoney",
      message: "ask the user again",
    });
    expect(result.code).not.toBe("policy_denied");
  });

  it("is a plain object, not an Error", () => {
    const result = approvalRequired("sendMoney", "ask the user again");
    expect(result).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
