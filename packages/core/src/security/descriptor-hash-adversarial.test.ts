import { describe, expect, it } from "vitest";
import { descriptorHash, type ToolDescriptor } from "../index.js";

// Adversarial regression suite for descriptorHash (01-core §4). The descriptor
// hash is the anchor a grant is pinned to: a forged-but-distinct hash would let
// an attacker either re-use a grant for a different tool (over-authorization) or
// spuriously break a legitimate grant. Every assertion here is about that seam.

const base = (): ToolDescriptor => ({
  name: "host_transfer",
  description: "Move money between accounts",
  inputSchema: { type: "object", properties: { amount: { type: "number" }, to: { type: "string" } } },
  risk: "write",
});

describe("descriptorHash determinism", () => {
  it("hashes the same descriptor to the same value across calls", () => {
    expect(descriptorHash(base())).toBe(descriptorHash(base()));
  });

  it("is invariant to inputSchema key insertion order (JCS sorts keys)", () => {
    const forward: ToolDescriptor = {
      name: "host_transfer",
      description: "Move money between accounts",
      inputSchema: { type: "object", properties: { amount: { type: "number" }, to: { type: "string" } } },
      risk: "write",
    };
    const reversed: ToolDescriptor = {
      // Every object level reordered: top-level fields, `properties`, and each leaf.
      risk: "write",
      inputSchema: { properties: { to: { type: "string" }, amount: { type: "number" } }, type: "object" },
      description: "Move money between accounts",
      name: "host_transfer",
    };
    expect(descriptorHash(forward)).toBe(descriptorHash(reversed));
  });
});

describe("descriptorHash distinctness", () => {
  it("changes when the name changes", () => {
    expect(descriptorHash(base())).not.toBe(descriptorHash({ ...base(), name: "host_transfer2" }));
  });

  it("changes when the description changes", () => {
    expect(descriptorHash(base())).not.toBe(descriptorHash({ ...base(), description: "Move money (v2)" }));
  });

  it("changes when the inputSchema changes", () => {
    const widened = { ...base(), inputSchema: { type: "object", properties: { amount: { type: "string" } } } };
    expect(descriptorHash(base())).not.toBe(descriptorHash(widened));
  });

  it("gives read, write, and destructive three distinct hashes", () => {
    const read = descriptorHash({ ...base(), risk: "read" });
    const write = descriptorHash({ ...base(), risk: "write" });
    const destructive = descriptorHash({ ...base(), risk: "destructive" });
    expect(new Set([read, write, destructive]).size).toBe(3);
  });

  it("changes when critical is toggled true vs false", () => {
    expect(descriptorHash({ ...base(), critical: true }))
      .not.toBe(descriptorHash({ ...base(), critical: false }));
  });
});

describe("descriptorHash preimage is exactly {name,description,inputSchema,risk,critical?}", () => {
  it("ignores extra descriptor fields so junk cannot forge a distinct-looking descriptor", () => {
    // ToolDescriptor's zod schema is passthrough, so a hostile producer can hang
    // arbitrary extra keys off a descriptor. Those keys MUST NOT enter the
    // preimage — otherwise two descriptors that are identical in every field the
    // guard cares about could carry different hashes and de-sync a grant.
    const withJunk = { ...base(), attackerControlled: "surprise", __proto__marker: 1 } as ToolDescriptor;
    expect(descriptorHash(withJunk)).toBe(descriptorHash(base()));
  });

  it("does not fold undefined critical into the preimage (absent stays absent)", () => {
    const explicitUndefined = { ...base(), critical: undefined };
    expect(descriptorHash(explicitUndefined as ToolDescriptor)).toBe(descriptorHash(base()));
  });

  it("distinguishes explicit critical:false from an omitted critical — fails CLOSED", () => {
    // A descriptor that newly pins critical:false hashes DIFFERENTLY from one that
    // omits critical. That is deliberately fail-closed: the mismatch spuriously
    // lapses any grant tied to the old hash (forcing re-approval) rather than
    // silently treating the two as equivalent and over-authorizing.
    const omitted: ToolDescriptor = {
      name: "host_transfer",
      description: "Move money between accounts",
      inputSchema: {},
      risk: "write",
    };
    expect(descriptorHash(omitted)).not.toBe(descriptorHash({ ...omitted, critical: false }));
  });
});
