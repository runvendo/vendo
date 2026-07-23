import { describe, expect, it } from "vitest";

import { devModel } from "./model-edge.js";

describe("dev-creds model, edge entry", () => {
  it("fails a model call with wiring guidance instead of reaching for Node resolution", async () => {
    const model = devModel();
    const call = (model as { doStream: (options: unknown) => Promise<unknown> }).doStream({});
    await expect(call).rejects.toThrow(/pass `model:`/);
    await expect(call).rejects.toThrow(/VENDO_API_KEY/);
  });

  it("keeps the module free of node builtins and CLI imports", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./model-edge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/\.\.\/cli\//);
  });
});
