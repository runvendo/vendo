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
    expect(mod).not.toHaveProperty("createRunQuery");
    expect(mod).not.toHaveProperty("createLocalStore");
  });
});

describe("vendo (root)", () => {
  it("is types-only: the built module has no runtime exports", async () => {
    const mod = await import("../dist/index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
