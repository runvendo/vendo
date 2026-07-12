import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, descriptorHash, type ToolDescriptor } from "./index.js";

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

const descriptorCanonical = (descriptor: ToolDescriptor): string => {
  const preimage: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    risk: descriptor.risk,
  };
  if (descriptor.critical !== undefined) preimage.critical = descriptor.critical;
  return canonicalJson(preimage);
};

describe("descriptorHash", () => {
  it("is independent of descriptor and schema key insertion order", () => {
    const first: ToolDescriptor = {
      name: "host_read",
      description: "Read",
      inputSchema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } },
      risk: "read",
    };
    const second: ToolDescriptor = {
      risk: "read",
      inputSchema: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" },
      description: "Read",
      name: "host_read",
    };
    expect(descriptorHash(first)).toBe(descriptorHash(second));
  });

  it("distinguishes absent critical from explicit false", () => {
    const descriptor: ToolDescriptor = {
      name: "host_read",
      description: "Read",
      inputSchema: {},
      risk: "read",
    };
    expect(descriptorHash(descriptor)).not.toBe(descriptorHash({ ...descriptor, critical: false }));
  });

  it("locks both canonical preimages and hashes to the committed vectors", () => {
    expect(vectors.format).toBe("vendo/descriptor-hash-vectors@1");
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(5);
    for (const vector of vectors.vectors) {
      expect(descriptorCanonical(vector.descriptor), vector.name).toBe(vector.canonical);
      expect(descriptorHash(vector.descriptor), vector.name).toBe(vector.hash);
    }
  });
});
