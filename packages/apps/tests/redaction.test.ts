import { type SecretsProvider } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { collectSecretValues, redactSecretJson, redactSecretText } from "../src/server/persistence/redaction.js";

const STRIPE_VALUE = "vendo_fixture_4eC39HqLyjWDarjtT1zdp7dc";

const secrets: SecretsProvider = {
  async get(name) {
    if (name === "STRIPE_KEY") return STRIPE_VALUE;
    if (name === "TINY") return "1";
    if (name === "BROKEN") throw new Error("vault offline");
    return undefined;
  },
};

describe("redaction primitives", () => {
  it("collects declared secret values, skipping short values and provider failures", async () => {
    const values = await collectSecretValues(["STRIPE_KEY", "TINY", "BROKEN", "MISSING"], secrets);
    expect([...values.entries()]).toEqual([["STRIPE_KEY", STRIPE_VALUE]]);
    expect((await collectSecretValues(["STRIPE_KEY"], undefined)).size).toBe(0);
  });

  it("replaces every occurrence of a value, naming the secret", () => {
    const values = new Map([["STRIPE_KEY", STRIPE_VALUE]]);
    expect(redactSecretText(`a=${STRIPE_VALUE} b=${STRIPE_VALUE}`, values))
      .toBe("a=[redacted:STRIPE_KEY] b=[redacted:STRIPE_KEY]");
    expect(redactSecretText("clean", values)).toBe("clean");
  });

  it("deep-scrubs JSON leaves and keys", () => {
    const values = new Map([["STRIPE_KEY", STRIPE_VALUE]]);
    expect(redactSecretJson({
      rows: [{ [STRIPE_VALUE]: `token ${STRIPE_VALUE}` }],
      count: 2,
      ok: true,
    }, values)).toEqual({
      rows: [{ "[redacted:STRIPE_KEY]": "token [redacted:STRIPE_KEY]" }],
      count: 2,
      ok: true,
    });
  });
});
