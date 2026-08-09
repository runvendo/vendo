/**
 * Lane A build-list item 5 — `requires: { sandbox }` is checked at createVendo
 * composition, NEVER at runtime. Architecture §10: "Composition rules are
 * boot-time errors ('Claude Code needs a sandbox adapter'), never runtime
 * surprises."
 */
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { assertHarnessComposable } from "../src/compose.js";
import { defineHarness } from "../src/define.js";

const noRequirements = defineHarness({
  name: "vendo",
  async *run() {
    // machine-less by design: in-process bash over the workspace
  },
});

const needsAMachine = defineHarness({
  name: "claude-code",
  requires: { sandbox: true },
  async *run() {
    // a spawned CLI needs somewhere to live
  },
});

describe("assertHarnessComposable", () => {
  it("passes a harness that requires nothing, wired or not", () => {
    expect(() => assertHarnessComposable(noRequirements, {})).not.toThrow();
    expect(() => assertHarnessComposable(noRequirements, { sandbox: {} })).not.toThrow();
  });

  it("passes a sandbox-requiring harness when the adapter slot is filled", () => {
    expect(() => assertHarnessComposable(needsAMachine, { sandbox: {} })).not.toThrow();
  });

  it("fails at boot when the sandbox adapter is missing, naming the harness and the fix", () => {
    expect(() => assertHarnessComposable(needsAMachine, {})).toThrow(VendoError);
    expect(() => assertHarnessComposable(needsAMachine, {})).toThrow(
      /claude-code needs a sandbox adapter/,
    );
  });

  it("is a validation error, so the composition surface reports it like any config mistake", () => {
    try {
      assertHarnessComposable(needsAMachine, {});
      expect.unreachable("expected a boot error");
    } catch (error) {
      expect((error as VendoError).code).toBe("validation");
    }
  });

  it("treats requires:{sandbox:false} as no requirement", () => {
    const explicit = defineHarness({
      name: "local-only",
      requires: { sandbox: false },
      async *run() {},
    });
    expect(() => assertHarnessComposable(explicit, {})).not.toThrow();
  });

  it("the adapter slot is the switch — no capability boolean is consulted", () => {
    // A falsy-but-present slot is not a wired adapter.
    expect(() => assertHarnessComposable(needsAMachine, { sandbox: undefined })).toThrow(VendoError);
  });
});
