import { VendoError, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { withUniqueToolTitles } from "./duplicate-titles.js";

const tool = (name: string, title?: string): ToolDescriptor => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  risk: "read",
  ...(title === undefined ? {} : { title }),
});

function registry(descriptors: ToolDescriptor[]): ToolRegistry {
  return {
    descriptors: async () => descriptors,
    execute: async () => ({ status: "ok", output: {} }),
  };
}

describe("duplicate tool titles fail the deployment (design §12)", () => {
  it("refuses a deployment where two tools read identically on a card", async () => {
    const checked = withUniqueToolTitles(registry([
      tool("maple_payments_send", "Send money"),
      tool("maple_transfers_create", "Send money"),
    ]));

    await expect(checked.descriptors()).rejects.toBeInstanceOf(VendoError);
  });

  it("names both offending tools and the title, so the message says what to fix", async () => {
    const checked = withUniqueToolTitles(registry([
      tool("maple_payments_send", "Send money"),
      tool("maple_transfers_create", "Send money"),
    ]));

    await expect(checked.descriptors()).rejects.toThrow(/maple_payments_send/);
    await expect(checked.descriptors()).rejects.toThrow(/maple_transfers_create/);
    await expect(checked.descriptors()).rejects.toThrow(/Send money/);
  });

  it("passes a clean deployment through untouched", async () => {
    const descriptors = [tool("a", "Alpha"), tool("b", "Beta"), tool("c")];
    const checked = withUniqueToolTitles(registry(descriptors));

    await expect(checked.descriptors()).resolves.toEqual(descriptors);
  });

  it("checks ONCE per deployment, not on every enumeration", async () => {
    // Every turn enumerates descriptors. Re-deriving the title map each time
    // would put a whole-registry scan on the hot path for a fact that cannot
    // change without a redeploy.
    let enumerations = 0;
    const inner: ToolRegistry = {
      descriptors: async () => { enumerations += 1; return [tool("a", "Alpha")]; },
      execute: async () => ({ status: "ok", output: {} }),
    };
    const checked = withUniqueToolTitles(inner);

    await checked.descriptors();
    await checked.descriptors();
    await checked.descriptors();

    // The scan now fetches the full unprojected set itself (it can no longer
    // reuse the caller's possibly-projected set — that was the memoization hole),
    // so the count is one one-time SCAN fetch plus one return fetch per call = 4.
    // The property the test guards is unchanged: the scan is memoized. If it
    // re-ran on every enumeration this would be 6, not 4.
    expect(enumerations).toBe(4);
  });

  it("keeps failing on every later call — a bad deployment never becomes healthy", async () => {
    const checked = withUniqueToolTitles(registry([
      tool("a", "Same"),
      tool("b", "same "),
    ]));

    await expect(checked.descriptors()).rejects.toBeInstanceOf(VendoError);
    await expect(checked.descriptors()).rejects.toBeInstanceOf(VendoError);
  });

  it("passes the projection context through to the wrapped registry", async () => {
    // THE LAW's projection rides descriptors(ctx); the wrapper must not eat it.
    let seen: unknown;
    const inner: ToolRegistry = {
      descriptors: async (ctx) => { seen = ctx; return [tool("a", "Alpha")]; },
      execute: async () => ({ status: "ok", output: {} }),
    };

    await withUniqueToolTitles(inner).descriptors({ venue: "automation", presence: "away" });

    expect(seen).toEqual({ venue: "automation", presence: "away" });
  });

  it("passes execute through on a clean deployment", async () => {
    const checked = withUniqueToolTitles(registry([tool("a", "Alpha")]));
    await expect(
      checked.execute({ id: "c1", tool: "a", args: {} }, {
        principal: { kind: "user", subject: "user_1" },
        venue: "chat",
        presence: "present",
        sessionId: "s1",
      }),
    ).resolves.toEqual({ status: "ok", output: {} });
  });
});
