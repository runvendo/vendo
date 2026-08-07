import { describe, expect, it } from "vitest";
import { describeDevCredential, resolveDevCredential } from "./resolve.js";

describe("resolveDevCredential (real keys only)", () => {
  it("prefers an explicit env key over VENDO_API_KEY, in provider order", async () => {
    expect(await resolveDevCredential({
      env: { ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2", VENDO_API_KEY: "vnd_x" },
    })).toEqual({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" });

    expect(await resolveDevCredential({
      env: { OPENAI_API_KEY: "sk-2", GOOGLE_GENERATIVE_AI_API_KEY: "sk-3" },
    })).toEqual({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" });

    expect(await resolveDevCredential({
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "sk-3" },
    })).toEqual({ rung: "env-key", provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" });
  });

  it("falls to VENDO_API_KEY, then to an honest none", async () => {
    expect(await resolveDevCredential({ env: { VENDO_API_KEY: "vnd_x" } }))
      .toEqual({ rung: "vendo-cloud" });
    expect(await resolveDevCredential({ env: {} })).toEqual({ rung: "none" });
  });

  it("ignores blank-valued keys", async () => {
    expect(await resolveDevCredential({ env: { ANTHROPIC_API_KEY: "  ", VENDO_API_KEY: "" } }))
      .toEqual({ rung: "none" });
  });

  it("VENDO_DEV_CREDENTIAL pins a rung; a pinned env-key without its key degrades to none", async () => {
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "vendo-cloud", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "vendo-cloud" });

    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:openai", OPENAI_API_KEY: "sk-2", ANTHROPIC_API_KEY: "sk-1" },
    })).toEqual({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" });

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
