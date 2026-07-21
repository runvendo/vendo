import { describe, it, expect } from "vitest";
import { scrubErrorDetail } from "./scrub.js";

describe("scrubErrorDetail", () => {
  it("returns empty string for non-string input", () => {
    for (const bad of [undefined, null, 42, true, {}, [], Symbol("x"), () => "x"]) {
      expect(scrubErrorDetail(bad as never)).toBe("");
    }
  });

  it("passes an already-clean message through mostly intact", () => {
    expect(scrubErrorDetail("Cannot find module 'react'")).toBe("Cannot find module 'react'");
    expect(scrubErrorDetail("ECONNREFUSED 127.0.0.1:5432")).toBe("ECONNREFUSED 127.0.0.1:5432");
  });

  it("redacts absolute unix paths", () => {
    expect(scrubErrorDetail("ENOENT: no such file /Users/alice/app/vendo.json here")).toBe(
      "ENOENT: no such file [path] here",
    );
  });

  it("redacts home-relative paths", () => {
    expect(scrubErrorDetail("config at ~/.vendo/telemetry.json is corrupt")).toBe(
      "config at [path] is corrupt",
    );
  });

  it("leaves single-segment paths alone", () => {
    // One component carries no user info worth hiding ("/tmp", "next/font").
    expect(scrubErrorDetail("mkdir /tmp failed")).toBe("mkdir /tmp failed");
  });

  it("redacts windows drive paths", () => {
    expect(scrubErrorDetail("EPERM: C:\\Users\\alice\\project\\vendo.json locked")).toBe(
      "EPERM: [path] locked",
    );
  });

  it("redacts a stack-trace line, keeping the frame structure readable", () => {
    const out = scrubErrorDetail(
      "Error: boom\n    at wireServer (/Users/alice/dev/host-app/src/server.ts:42:7)",
    );
    expect(out).not.toContain("alice");
    expect(out).not.toContain("host-app");
    expect(out).toContain("Error: boom");
    expect(out).toContain("[path]");
  });

  it("redacts email addresses", () => {
    expect(scrubErrorDetail("login failed for alice@example.com, retry")).toBe(
      "login failed for [email], retry",
    );
  });

  it("redacts a Vendo Cloud key mid-sentence", () => {
    const key = `vnd_${"0123456789abcdef".repeat(2)}01234567`; // 40 hex chars
    expect(scrubErrorDetail(`401 from gateway: key ${key} was rejected`)).toBe(
      "401 from gateway: key [secret] was rejected",
    );
  });

  it("redacts PostHog and OpenAI-style keys", () => {
    expect(scrubErrorDetail("bad key phc_siVHW4wVh8yDeDzMgnjL")).toBe("bad key [secret]");
    expect(scrubErrorDetail("bad key sk-proj-abc123XYZ")).toBe("bad key [secret]");
  });

  it("redacts bearer tokens", () => {
    expect(scrubErrorDetail('rejected header "Authorization: Bearer eyJhbGciOi.payload.sig"')).toBe(
      'rejected header "Authorization: [secret]"',
    );
  });

  it("redacts long hex runs (32+)", () => {
    const sha = "a".repeat(64);
    expect(scrubErrorDetail(`object ${sha} missing`)).toBe("object [secret] missing");
  });

  it("redacts long base64-ish runs (32+)", () => {
    const blob = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==".repeat(2);
    expect(scrubErrorDetail(`payload ${blob} rejected`)).toBe("payload [secret] rejected");
  });

  it("keeps ordinary short identifiers that resemble no secret", () => {
    expect(scrubErrorDetail("hook useAgent failed in AgentDock")).toBe(
      "hook useAgent failed in AgentDock",
    );
  });

  it("collapses repeated whitespace and newlines to single spaces", () => {
    expect(scrubErrorDetail("a\n\n  b\t\tc")).toBe("a b c");
  });

  it("truncates to 200 chars after redaction, so trailing secrets still vanish", () => {
    const key = `vnd_${"f".repeat(40)}`;
    const input = `${"x".repeat(250)} ${key}`;
    const out = scrubErrorDetail(input);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toContain("vnd_");
    // Redaction ran on the full string first — nothing survives past the cap.
    expect(scrubErrorDetail(`${key} tail`).startsWith("[secret] tail")).toBe(true);
  });

  it("redacts a secret that straddles the 200-char truncation boundary", () => {
    // The key STARTS at char 185, so a truncate-before-redact implementation
    // would slice mid-key, leaving "vnd_" plus ~11 hex chars that no pass
    // matches (the vnd_ pattern needs all 40, the hex/base64 nets need 32+).
    // Only redact-before-truncate removes every fragment.
    const key = `vnd_${"0123456789abcdef".repeat(2)}01234567`; // vnd_ + 40 hex
    const input = `${"x".repeat(184)} ${key} rejected`;
    const out = scrubErrorDetail(input);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toContain("vnd_");
    expect(out).toContain("[secret]");
  });

  it("never throws", () => {
    expect(() => scrubErrorDetail("\0".repeat(10_000))).not.toThrow();
  });
});
