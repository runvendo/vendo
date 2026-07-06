import { describe, expect, it } from "vitest";

describe("vendoai/server", () => {
  it("exposes the route-handler surface", async () => {
    const mod = await import("../dist/server.js");
    expect(mod).toHaveProperty("createVendoHandler");
    expect(mod).toHaveProperty("createVendoFetchHandler");
    expect(mod).toHaveProperty("toNodeHandler");
  });
});

describe("vendoai/react", () => {
  it("exposes the batteries-included client, the provider/hooks, and shell surfaces", async () => {
    const mod = await import("../dist/react.js");
    expect(mod).toHaveProperty("VendoRoot");
    expect(mod).toHaveProperty("useVendoChat");
    expect(mod).toHaveProperty("ApprovalCard");
  });

  it("resolves the RunQuery collision in favor of @vendoai/client (no ambiguous-export drop)", async () => {
    const client = await import("@vendoai/client");
    const shell = await import("../dist/react.js");
    // Both packages export a `createRunQuery` / type named `RunQuery`; the
    // umbrella module must still surface the runtime value (createRunQuery
    // only lives in @vendoai/client, so its presence proves client's half of
    // the star-export survived rather than being silently shadowed).
    expect(shell).toHaveProperty("createRunQuery");
    expect(shell.createRunQuery).toBe(client.createRunQuery);
  });
});

describe("vendo (root)", () => {
  it("is types-only: the built module has no runtime exports", async () => {
    const mod = await import("../dist/index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
