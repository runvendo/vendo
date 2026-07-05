import { describe, expect, it } from "vitest";
import type { GeneratedPayload } from "@vendoai/core";
import { NORMALIZER_VERSION } from "./baseline";
import { createRemixSealer, deriveSealKey, sealBody } from "./envelope";

const payload: GeneratedPayload = {
  formatVersion: "vendo-genui/v1",
  root: "r",
  nodes: [{ id: "r", component: "Variant", source: "generated" }],
  components: { Variant: "export default function Variant() { return null }" },
};

const mintInput = {
  anchorId: "upcoming-deadlines",
  principalUserId: "user-1",
  payload,
  sources: { Variant: "export default function Variant() { return null }" },
  sourceHash: "src-hash",
  baseHash: "base-hash",
  issuedAt: "2026-07-04T12:00:00.000Z",
};

const verifyContext = { anchorId: "upcoming-deadlines", principalUserId: "user-1" };

describe("createRemixSealer", () => {
  it("mint → verify round-trips the authored state", () => {
    const sealer = createRemixSealer(deriveSealKey({ secret: "s3cret" })!);
    const sealed = sealer.mint(mintInput);
    const verified = sealer.verify(sealed, verifyContext);
    expect(verified).not.toBeNull();
    expect(verified!.payload).toEqual(payload);
    expect(verified!.sources).toEqual(mintInput.sources);
    expect(verified!.baseHash).toBe("base-hash");
    expect(verified!.sourceHash).toBe("src-hash");
  });

  it("verification is key-order independent (canonical JSON)", () => {
    const sealer = createRemixSealer(deriveSealKey({ secret: "s3cret" })!);
    const sealed = sealer.mint(mintInput);
    // Re-encode the envelope body with reordered keys; signature must still verify.
    const [body, sig] = sealed.split(".");
    const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    const shuffled = `${Buffer.from(JSON.stringify(reordered), "utf8").toString("base64url")}.${sig}`;
    expect(sealer.verify(shuffled, verifyContext)).not.toBeNull();
  });

  it("rejects tampering with any field", () => {
    const sealer = createRemixSealer(deriveSealKey({ secret: "s3cret" })!);
    const sealed = sealer.mint(mintInput);
    const [body, sig] = sealed.split(".");
    const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    parsed.sources = { Variant: "export default function Evil() { return null }" };
    const tampered = `${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")}.${sig}`;
    expect(sealer.verify(tampered, verifyContext)).toBeNull();
    expect(sealer.verify("garbage", verifyContext)).toBeNull();
    expect(sealer.verify(`${body}.deadbeef`, verifyContext)).toBeNull();
  });

  it("rejects cross-anchor and cross-principal replay", () => {
    const sealer = createRemixSealer(deriveSealKey({ secret: "s3cret" })!);
    const sealed = sealer.mint(mintInput);
    expect(sealer.verify(sealed, { ...verifyContext, anchorId: "other-anchor" })).toBeNull();
    expect(sealer.verify(sealed, { ...verifyContext, principalUserId: "user-2" })).toBeNull();
  });

  it("rejects a stale normalizer version", () => {
    const sealer = createRemixSealer(deriveSealKey({ secret: "s3cret" })!);
    const sealed = sealer.mint(mintInput);
    const [body] = sealed.split(".");
    const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    expect(parsed.normalizerVersion).toBe(NORMALIZER_VERSION);
    // A sealer can't mint a stale version; simulate by verifying with a bumped expectation.
    const bumped = createRemixSealer(deriveSealKey({ secret: "s3cret" })!, {
      normalizerVersion: "999",
    });
    expect(bumped.verify(sealed, verifyContext)).toBeNull();
  });

  it("rejects internal inconsistency (payloadHash mismatch) even with a valid signature", () => {
    const key = deriveSealKey({ secret: "s3cret" })!;
    const sealer = createRemixSealer(key);
    const sealed = sealer.mint(mintInput);
    const [body] = sealed.split(".");
    const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    // Defense-in-depth: a correctly-signed body whose payload no longer
    // matches its payloadHash must still be rejected.
    parsed.payload = { ...payload, root: "changed" };
    const resigned = sealBody(parsed, key);
    expect(sealer.verify(resigned, verifyContext)).toBeNull();
  });

  it("different keys never cross-verify; kid mismatches reject fast", () => {
    const a = createRemixSealer(deriveSealKey({ secret: "key-a" })!);
    const b = createRemixSealer(deriveSealKey({ secret: "key-b" })!);
    const sealed = a.mint(mintInput);
    expect(b.verify(sealed, verifyContext)).toBeNull();
  });
});

describe("deriveSealKey", () => {
  it("prefers the explicit secret, else HKDF from provider key material, else null", () => {
    const fromSecret = deriveSealKey({ secret: "explicit", providerKey: "sk-ant-xyz" });
    const fromProvider = deriveSealKey({ providerKey: "sk-ant-xyz" });
    const none = deriveSealKey({});
    expect(fromSecret).not.toBeNull();
    expect(fromProvider).not.toBeNull();
    expect(none).toBeNull();
    expect(fromSecret!.kid).not.toBe(fromProvider!.kid);
    // Deterministic: same inputs, same key id.
    expect(deriveSealKey({ providerKey: "sk-ant-xyz" })!.kid).toBe(fromProvider!.kid);
  });
});
