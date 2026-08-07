import type { Harness, HarnessEvent, Turn } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { defineHarness } from "./define.js";

describe("defineHarness", () => {
  it("returns the definition itself, not a wrapper", () => {
    const def = {
      name: "acme-loop",
      async *run(_turn: Turn): AsyncGenerator<HarnessEvent, void, void> {
        yield { type: "text", delta: "hi" };
      },
    };
    const harness = defineHarness(def);
    expect(harness).toBe(def);
  });

  it("carries declared requires and optionsSchema through untouched", () => {
    const optionsSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as { depth: number } }),
      },
    };
    const harness: Harness<{ depth: number }> = defineHarness({
      name: "needs-a-box",
      requires: { sandbox: true },
      optionsSchema,
      async *run() {
        // a harness may yield nothing at all
      },
    });
    expect(harness.name).toBe("needs-a-box");
    expect(harness.requires).toEqual({ sandbox: true });
    expect(harness.optionsSchema).toBe(optionsSchema);
  });

  it("a harness authored as a plain factory closure needs no factory concept", () => {
    const acme = (deps: { logger: string[] }): Harness =>
      defineHarness({
        name: "acme",
        async *run() {
          deps.logger.push("ran");
        },
      });
    const logger: string[] = [];
    const harness = acme({ logger });
    // Drain the generator so the closure's side effect proves the dep arrived.
    return (async () => {
      for await (const _event of harness.run({} as Turn)) void _event;
      expect(logger).toEqual(["ran"]);
    })();
  });
});
