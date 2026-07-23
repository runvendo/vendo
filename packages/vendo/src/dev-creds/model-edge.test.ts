import { describe, expect, it } from "vitest";

import { configureVendoModelSlots, devModel, vendoModel } from "./model-edge.js";

describe("dev-creds model, edge entry", () => {
  it("fails a model call with wiring guidance instead of reaching for Node resolution", async () => {
    const model = devModel();
    const call = (model as { doStream: (options: unknown) => Promise<unknown> }).doStream({});
    await expect(call).rejects.toThrow(/pass `model:`/);
    await expect(call).rejects.toThrow(/VENDO_API_KEY/);
  });

  it("exports vendoModel + configureVendoModelSlots with the same honest refusal", async () => {
    // Export parity with the Node build: the server entry imports both from
    // "#dev-creds/model", so the edge condition must resolve them too.
    expect(() => configureVendoModelSlots({ judge: "vendo-judge" })).not.toThrow();
    const model = vendoModel("vendo");
    const call = (model as { doGenerate: (options: unknown) => Promise<unknown> }).doGenerate({});
    await expect(call).rejects.toThrow(/pass `model:`/);
  });

  it("keeps the module free of node builtins and CLI imports", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./model-edge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/\.\.\/cli\//);
  });
});
