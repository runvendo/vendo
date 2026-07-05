import { describe, it, expect } from "vitest";
import { resolveConsent } from "./consent.js";

const base = { env: {} as Record<string, string | undefined>, optedOut: false, runtime: false };

describe("resolveConsent", () => {
  it("allows by default on the build side", () => {
    expect(resolveConsent(base).allowed).toBe(true);
  });

  it("disables when VENDO_TELEMETRY_DISABLED=1", () => {
    expect(resolveConsent({ ...base, env: { VENDO_TELEMETRY_DISABLED: "1" } }).allowed).toBe(false);
  });

  it("disables when DO_NOT_TRACK=1", () => {
    expect(resolveConsent({ ...base, env: { DO_NOT_TRACK: "1" } }).allowed).toBe(false);
  });

  it("disables in CI", () => {
    expect(resolveConsent({ ...base, env: { CI: "true" } }).allowed).toBe(false);
  });

  it("disables when the config records opt-out", () => {
    expect(resolveConsent({ ...base, optedOut: true }).allowed).toBe(false);
  });

  it("disables runtime callers in production", () => {
    expect(resolveConsent({ ...base, runtime: true, env: { NODE_ENV: "production" } }).allowed).toBe(false);
  });

  it("allows runtime callers in development", () => {
    expect(resolveConsent({ ...base, runtime: true, env: { NODE_ENV: "development" } }).allowed).toBe(true);
  });
});
