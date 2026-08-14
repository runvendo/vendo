/**
 * A boot error that names a symbol has to name where the symbol COMES FROM.
 *
 * Every one of these sentences is copied verbatim by the person reading it, and
 * `claudeCode` is not on the `@vendoai/harnesses` root barrel — so "pass
 * `harness: claudeCode()`" sent a host straight into `TypeError: claudeCode is
 * not a function`. The path is pinned here against the REAL module, so a moved
 * export breaks this suite instead of the next host's first hour.
 */
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, e2b, postgres } from "../src/index.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-error-imports-${stores++}` });

/** The zero-key rung, pinned so the suite reads the same on a laptop that has
 *  run `vendo login` and on one that has not. */
const withoutRung = (): void => {
  vi.stubEnv("VENDO_DEV_CREDENTIAL", "");
  vi.stubEnv("VENDO_API_KEY", "");
};

/** A harness that thinks on a machine — the one that needs a sandbox slot. */
const boxy = () => defineHarness({
  name: "boxy",
  requires: { sandbox: true, toolDoor: true },
  async *run() {},
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the symbols a boot error names", () => {
  it("says where claudeCode and anthropic live — the two the no-model error hands out", async () => {
    withoutRung();
    const support = agent({ name: "support", store: memoryStore() });

    await expect(support.run("do a thing")).rejects.toThrow(
      /`harness: claudeCode\(\)`, importing `claudeCode` from `@vendoai\/harnesses\/claude-code`/,
    );
    await expect(support.run("do a thing")).rejects.toThrow(
      /`model: anthropic\("claude-sonnet-4-6"\)`, importing `anthropic` from `@ai-sdk\/anthropic`/,
    );
  });

  it("claudeCode really is at that path, and really is not on the root barrel", async () => {
    // The verifier's exact failure: the suggestion, pasted verbatim, threw.
    const subpath = await import("@vendoai/harnesses/claude-code");
    const barrel = await import("@vendoai/harnesses");

    expect(typeof subpath.claudeCode).toBe("function");
    expect(barrel).not.toHaveProperty("claudeCode");
  });

  it("says where e2b lives, on both sandbox errors", () => {
    withoutRung();
    expect(() => agent({ name: "support", harness: boxy(), store: memoryStore() }))
      .toThrow(/import `e2b` from `@vendoai\/agents`/);

    vi.stubEnv("VENDO_API_KEY", "vk_test");
    expect(() => agent({ name: "support", harness: boxy(), store: memoryStore() }))
      .toThrow(/import `e2b` from `@vendoai\/agents`/);
  });

  // The paths above are only true because this package exports them.
  it("exports the symbols it points at", () => {
    expect(typeof e2b).toBe("function");
    expect(typeof postgres).toBe("function");
  });
});
