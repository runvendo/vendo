import { describe, expect, it } from "vitest";
import { resolveRemixSealer } from "./seal";

describe("resolveRemixSealer", () => {
  it("explicit sealSecret option wins over everything", () => {
    const a = resolveRemixSealer({
      sealSecret: "opt",
      hasInjectedModel: false,
      env: { VENDO_SEAL_SECRET: "env", ANTHROPIC_API_KEY: "sk" },
    });
    expect(a).toBeDefined();
  });

  it("falls back to VENDO_SEAL_SECRET, then the provider key on the default-model path", () => {
    expect(
      resolveRemixSealer({ hasInjectedModel: false, env: { VENDO_SEAL_SECRET: "env" } }),
    ).toBeDefined();
    expect(
      resolveRemixSealer({ hasInjectedModel: false, env: { ANTHROPIC_API_KEY: "sk" } }),
    ).toBeDefined();
  });

  it("never derives from the provider key when the host injected its own model", () => {
    expect(
      resolveRemixSealer({ hasInjectedModel: true, env: { ANTHROPIC_API_KEY: "sk" } }),
    ).toBeUndefined();
    // …but an explicit secret still works there.
    expect(
      resolveRemixSealer({
        hasInjectedModel: true,
        env: { VENDO_SEAL_SECRET: "env", ANTHROPIC_API_KEY: "sk" },
      }),
    ).toBeDefined();
  });

  it("no material → sealing off", () => {
    expect(resolveRemixSealer({ hasInjectedModel: false, env: {} })).toBeUndefined();
  });

  it("same secret verifies across instances (stable derivation)", () => {
    const a = resolveRemixSealer({ sealSecret: "s", hasInjectedModel: false, env: {} })!;
    const b = resolveRemixSealer({ sealSecret: "s", hasInjectedModel: false, env: {} })!;
    const sealed = a.mint({
      anchorId: "x",
      principalUserId: "u",
      payload: {
        formatVersion: "vendo-genui/v1",
        root: "r",
        nodes: [{ id: "r", component: "C", source: "generated" }],
        components: { C: "export default function C(){return null}" },
      },
      sources: { C: "export default function C(){return null}" },
      sourceHash: "sh",
      baseHash: "bh",
      issuedAt: "2026-07-04T00:00:00.000Z",
    });
    expect(b.verify(sealed, { anchorId: "x", principalUserId: "u" })).not.toBeNull();
  });
});
