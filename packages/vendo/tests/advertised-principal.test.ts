import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

// The snippet both identity refusals print, and the three docs pages copy,
// verbatim. It shipped once in a form that did not compile, because nothing
// ever typechecked it — this file is that gate: `tsconfig.test.json` includes
// `tests`, so the `principal` line below IS the assertion. Change the
// `principal` type and you hear about it here, not in a host's terminal.
describe("the advertised principal snippet", () => {
  it("compiles and composes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-advertised-principal-"));
    const store = createStore({ dataDir });
    try {
      const vendo = createVendo({
        models: { default: {} as LanguageModel },
        store,
        principal: async () => ({ kind: "user", subject: "dev" }),
      });
      expect(vendo.handler).toBeTypeOf("function");
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
