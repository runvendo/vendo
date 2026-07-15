import { describe, expect, it } from "vitest";
import { mintRunToken, verifyRunToken, type RunTokenPayload } from "../run-token.js";

// Red-team suite for the per-process HMAC run token (06-apps §4.2, block-plan decision 5).
// The token is the ONLY authority the sandbox proxy trusts: everything the machine
// can do is derived from these signed claims. So the token must be unforgeable
// (cross-app reuse impossible), tamper-evident (presence/appId flips rejected), and
// replay-bounded (expiry enforced) without the per-process secret.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
};

/** Decode a token's payload segment, mutate it, and re-encode keeping the OLD signature. */
const tamperPayload = (token: string, mutate: (payload: RunTokenPayload) => void): string => {
  const [payloadPart, signaturePart] = token.split(".");
  const payload = JSON.parse(decoder.decode(fromBase64Url(payloadPart!))) as RunTokenPayload;
  mutate(payload);
  const forgedPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${forgedPart}.${signaturePart}`;
};

const SECRET = "process-secret-A";
const future = (): number => Date.now() + 60_000;

const payload = (overrides: Partial<RunTokenPayload> = {}): RunTokenPayload => ({
  appId: "app_A",
  subject: "sub_A",
  runId: "run_x",
  presence: "present",
  expiresAt: future(),
  jti: "jti_A",
  ...overrides,
});

describe("run token abuse", () => {
  it("verifies a valid token to its exact signed payload", async () => {
    const claims = payload();
    const token = await mintRunToken(SECRET, claims);
    await expect(verifyRunToken(SECRET, token)).resolves.toEqual(claims);
  });

  it("rejects a token signed with a different per-process secret (forge blocked)", async () => {
    const token = await mintRunToken("process-secret-B", payload());
    // A different machine cache / process cannot mint a token this proxy will accept.
    await expect(verifyRunToken(SECRET, token)).resolves.toBeNull();
  });

  it("rejects a token past its expiry (replay-after-expiry blocked)", async () => {
    const token = await mintRunToken(SECRET, payload({ expiresAt: Date.now() - 1 }));
    await expect(verifyRunToken(SECRET, token)).resolves.toBeNull();
  });

  it("rejects a token whose payload appId was flipped after signing (cross-app reuse)", async () => {
    const token = await mintRunToken(SECRET, payload({ appId: "app_A" }));
    const forged = tamperPayload(token, (claims) => { claims.appId = "app_evil"; });
    await expect(verifyRunToken(SECRET, forged)).resolves.toBeNull();
  });

  it("rejects a token whose presence was flipped present->away after signing", async () => {
    const token = await mintRunToken(SECRET, payload({ presence: "present" }));
    const forged = tamperPayload(token, (claims) => { claims.presence = "away"; });
    // A present-scoped token cannot be upgraded to an away (act-as-user) token.
    await expect(verifyRunToken(SECRET, forged)).resolves.toBeNull();
  });

  it("rejects a token whose subject was swapped after signing (principal spoof)", async () => {
    const token = await mintRunToken(SECRET, payload({ subject: "sub_A" }));
    const forged = tamperPayload(token, (claims) => { claims.subject = "sub_victim"; });
    await expect(verifyRunToken(SECRET, forged)).resolves.toBeNull();
  });

  it("rejects a token minted without a jti anti-replay nonce (fail-closed, ENG-251)", async () => {
    const { jti, ...withoutJti } = payload();
    void jti;
    const token = await mintRunToken(SECRET, withoutJti as RunTokenPayload);
    // A token with no jti can never be revoked, so it is not a valid token.
    await expect(verifyRunToken(SECRET, token)).resolves.toBeNull();
  });

  it("rejects malformed tokens without throwing", async () => {
    for (const malformed of [
      "",
      "onlyonesegment",
      "not.base64url.extra",
      "!!!.@@@",
      "a.b.c",
      ".",
      "eyJhIjoxfQ.", // valid-ish payload, empty signature
    ]) {
      await expect(verifyRunToken(SECRET, malformed)).resolves.toBeNull();
    }
  });
});
