import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { descriptorHash, duplicateToolTitles, type ToolDescriptor } from "./index.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/descriptor-hash.json", import.meta.url), "utf8"),
) as {
  format: string;
  vectors: Array<{
    name: string;
    descriptor: ToolDescriptor;
    canonical: string;
    hash: string;
  }>;
};

const base = (): ToolDescriptor => ({
  name: "host_transfer",
  description: "Move money between accounts",
  inputSchema: { type: "object", properties: { amount: { type: "number" }, to: { type: "string" } } },
  risk: "write",
});

// The descriptor hash is the anchor a grant is pinned to: a forged-but-distinct
// hash would let an attacker re-use a grant for a different tool
// (over-authorization) or spuriously break a legitimate grant.

describe("descriptorHash is deterministic", () => {
  it("hashes the same descriptor to the same value across calls", () => {
    expect(descriptorHash(base())).toBe(descriptorHash(base()));
  });

  it("is invariant to key insertion order at every object level (JCS sorts keys)", () => {
    const reversed: ToolDescriptor = {
      risk: "write",
      inputSchema: { properties: { to: { type: "string" }, amount: { type: "number" } }, type: "object" },
      description: "Move money between accounts",
      name: "host_transfer",
    };
    expect(descriptorHash(base())).toBe(descriptorHash(reversed));
  });
});

describe("descriptorHash distinguishes every field it covers", () => {
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

  it("changes when confirmEach is toggled true vs false", () => {
    expect(descriptorHash({ ...base(), confirmEach: true }))
      .not.toBe(descriptorHash({ ...base(), confirmEach: false }));
  });

  it("a retitle invalidates grants exactly like a rename", () => {
    expect(descriptorHash({ ...base(), title: "Send a payment" }))
      .not.toBe(descriptorHash({ ...base(), title: "Send money to a recipient" }));
  });

  it("is still insensitive to key order once a title is present", () => {
    const one: ToolDescriptor = { ...base(), title: "Send a payment" };
    const two: ToolDescriptor = {
      title: "Send a payment",
      risk: base().risk,
      inputSchema: base().inputSchema,
      description: base().description,
      name: base().name,
    };
    expect(descriptorHash(one)).toBe(descriptorHash(two));
  });
});

describe("descriptorHash preimage is exactly {name,description,inputSchema,risk,confirmEach?,title?}", () => {
  it("ignores extra descriptor fields so junk cannot forge a distinct-looking descriptor", () => {
    // ToolDescriptor's zod schema is passthrough, so a hostile producer can hang
    // arbitrary extra keys off a descriptor. Those keys MUST NOT enter the
    // preimage — otherwise two descriptors that are identical in every field the
    // guard cares about could carry different hashes and de-sync a grant.
    const withJunk = { ...base(), attackerControlled: "surprise", __proto__marker: 1 } as ToolDescriptor;
    expect(descriptorHash(withJunk)).toBe(descriptorHash(base()));
  });

  it("treats an explicitly undefined optional as absent", () => {
    // Every grant minted before `title` and `confirmEach` existed must keep
    // matching, or adding either field would silently revoke the whole estate.
    expect(descriptorHash({ ...base(), confirmEach: undefined } as ToolDescriptor)).toBe(descriptorHash(base()));
    expect(descriptorHash({ ...base(), title: undefined })).toBe(descriptorHash(base()));
  });

  it("distinguishes explicit confirmEach:false from an omitted confirmEach — fails CLOSED", () => {
    // A descriptor that newly pins confirmEach:false hashes DIFFERENTLY from one
    // that omits confirmEach. That is deliberately fail-closed: the mismatch
    // spuriously lapses any grant tied to the old hash (forcing re-approval)
    // rather than silently treating the two as equivalent and over-authorizing.
    const omitted: ToolDescriptor = {
      name: "host_transfer",
      description: "Move money between accounts",
      inputSchema: {},
      risk: "write",
    };
    expect(descriptorHash(omitted)).not.toBe(descriptorHash({ ...omitted, confirmEach: false }));
  });

  it("locks the committed vectors", () => {
    // Each vector's canonical form is re-derived from its hash by an independent
    // node:crypto oracle in contract-coverage.e2e.test.ts, so this file pins the
    // hashes without re-implementing the preimage.
    expect(vectors.format).toBe("vendo/descriptor-hash-vectors@1");
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(5);
    for (const vector of vectors.vectors) {
      expect(descriptorHash(vector.descriptor), vector.name).toBe(vector.hash);
    }
  });
});

describe("duplicate tool titles are a boot error", () => {
  it("names every title two or more tools would read identically under", () => {
    const found = duplicateToolTitles([
      { ...base(), name: "maple_payments_send", title: "Send money" },
      { ...base(), name: "maple_transfers_create", title: "Send money" },
      { ...base(), name: "maple_invoices_list", title: "List invoices", risk: "read" },
    ]);

    expect(found).toEqual([{ title: "Send money", tools: ["maple_payments_send", "maple_transfers_create"] }]);
  });

  it("accepts distinct titles, and ignores tools that carry none", () => {
    expect(duplicateToolTitles([
      { ...base(), name: "a", title: "Alpha" },
      { ...base(), name: "b", title: "Beta" },
      { ...base(), name: "c" },
      { ...base(), name: "d" },
    ])).toEqual([]);
  });

  it("compares titles as a person reads them — case and surrounding space do not distinguish two actions", () => {
    const found = duplicateToolTitles([
      { ...base(), name: "a", title: "Send money" },
      { ...base(), name: "b", title: "  send MONEY " },
    ]);
    expect(found).toHaveLength(1);
  });
});
