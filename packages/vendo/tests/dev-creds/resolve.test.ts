import { describe, expect, it } from "vitest";
import { describeDevCredential, resolveDevCredential } from "../../src/dev-creds/resolve.js";

describe("resolveDevCredential (real keys only)", () => {
  // THE SELECTION LAW (2026-08-11), and the one breaking change in it: a provider
  // key lying in the environment used to WIN this ladder, so a key left in a shell
  // chose the model — and the provider — for the host. Keys are credentials;
  // `models` on createVendo is what selects.
  it("does NOT select a provider from a bare env key, whichever provider it is", async () => {
    for (const envVar of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
      expect(await resolveDevCredential({ env: { [envVar]: "sk-1" } }), envVar)
        .toEqual({ rung: "none" });
    }
    // All three at once is still nothing: there is no provider order left to have.
    expect(await resolveDevCredential({
      env: { ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2", GOOGLE_GENERATIVE_AI_API_KEY: "sk-3" },
    })).toEqual({ rung: "none" });
  });

  it("lets VENDO_API_KEY fill the slot even when provider keys are lying around", async () => {
    expect(await resolveDevCredential({
      env: { ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2", VENDO_API_KEY: "vnd_x" },
    })).toEqual({ rung: "vendo-cloud" });
  });

  it("falls to VENDO_API_KEY, then to an honest none", async () => {
    expect(await resolveDevCredential({ env: { VENDO_API_KEY: "vnd_x" } }))
      .toEqual({ rung: "vendo-cloud" });
    expect(await resolveDevCredential({ env: {} })).toEqual({ rung: "none" });
  });

  it("ignores blank-valued keys", async () => {
    expect(await resolveDevCredential({ env: { VENDO_API_KEY: "  " } }))
      .toEqual({ rung: "none" });
  });

  it("VENDO_DEV_CREDENTIAL (internal only) pins a rung; a pin whose key is missing degrades to none", async () => {
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "vendo-cloud", VENDO_API_KEY: "vnd_x", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "vendo-cloud" });

    // Without VENDO_API_KEY the cloud rung cannot resolve. It must degrade like
    // the env-key pin below, not hand the Cloud gateway an undefined apiKey —
    // @ai-sdk/anthropic then falls back to process.env.ANTHROPIC_API_KEY and
    // sends the host's own provider key to a third-party origin.
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "vendo-cloud", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "none" });

    // The pin is the ONLY door to the env-key rung now — ENV_KEY_VARS stays as its
    // credential table, but nothing arrives here by accident.
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:openai", OPENAI_API_KEY: "sk-2", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" });

    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" });

    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:google", GOOGLE_GENERATIVE_AI_API_KEY: "sk-3" },
    })).toEqual({ rung: "env-key", provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" });

    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:openai", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "none" });

    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "none", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "none" });
  });

  it("describes every rung in one human line", () => {
    expect(describeDevCredential({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }))
      .toBe("explicit ANTHROPIC_API_KEY (anthropic)");
    expect(describeDevCredential({ rung: "vendo-cloud" })).toBe("VENDO_API_KEY (Vendo Cloud)");
    expect(describeDevCredential({ rung: "none" })).toBe("no model credential found");
  });
});
