import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeDevCredential,
  hasSessionConsent,
  readDevSessionConsent,
  resolveDevCredential,
  writeDevSessionConsent,
} from "./resolve.js";

const probes = (claude: boolean, codex: boolean, calls: string[] = []) => ({
  claude: async () => {
    calls.push("claude");
    return claude;
  },
  codex: async () => {
    calls.push("codex");
    return codex;
  },
});

describe("resolveDevCredential ladder order", () => {
  it("explicit env key beats everything, in ANTHROPIC → OPENAI → GOOGLE order", async () => {
    const calls: string[] = [];
    expect(await resolveDevCredential({
      env: { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", VENDO_API_KEY: "vk" },
      probes: probes(true, true, calls),
    })).toEqual({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" });
    // Explicit beats implicit: the CLI probes never even ran.
    expect(calls).toEqual([]);

    expect(await resolveDevCredential({
      env: { OPENAI_API_KEY: "sk-o", GOOGLE_GENERATIVE_AI_API_KEY: "sk-g" },
      probes: probes(true, true),
    })).toEqual({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" });

    expect(await resolveDevCredential({
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "sk-g" },
      probes: probes(true, true),
    })).toEqual({ rung: "env-key", provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" });
  });

  it("ignores empty env keys", async () => {
    expect(await resolveDevCredential({
      env: { ANTHROPIC_API_KEY: "  " },
      probes: probes(false, false),
    })).toEqual({ rung: "none" });
  });

  it("prefers an authed claude session over codex, codex over VENDO_API_KEY", async () => {
    expect(await resolveDevCredential({ env: {}, probes: probes(true, true) }))
      .toEqual({ rung: "claude-session" });
    expect(await resolveDevCredential({ env: { VENDO_API_KEY: "vk" }, probes: probes(false, true) }))
      .toEqual({ rung: "codex-session" });
    expect(await resolveDevCredential({ env: { VENDO_API_KEY: "vk" }, probes: probes(false, false) }))
      .toEqual({ rung: "vendo-cloud" });
    expect(await resolveDevCredential({ env: {}, probes: probes(false, false) }))
      .toEqual({ rung: "none" });
  });

  it("REFUSES session rungs in production — probes never run", async () => {
    const calls: string[] = [];
    expect(await resolveDevCredential({
      env: { NODE_ENV: "production" },
      probes: probes(true, true, calls),
    })).toEqual({ rung: "none" });
    expect(calls).toEqual([]);

    // Env keys and VENDO_API_KEY still resolve in production.
    expect(await resolveDevCredential({
      env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-a" },
      probes: probes(true, true),
    })).toEqual({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" });
    expect(await resolveDevCredential({
      env: { NODE_ENV: "production", VENDO_API_KEY: "vk" },
      probes: probes(true, true),
    })).toEqual({ rung: "vendo-cloud" });
  });

  it("VENDO_DEV_CREDENTIAL pins a rung, but session pins still refuse in production", async () => {
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "codex-session", ANTHROPIC_API_KEY: "sk-a" },
      probes: probes(true, true),
    })).toEqual({ rung: "codex-session" });
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "codex-session", NODE_ENV: "production" },
      probes: probes(true, true),
    })).toEqual({ rung: "none" });
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "none", ANTHROPIC_API_KEY: "sk-a" },
      probes: probes(true, true),
    })).toEqual({ rung: "none" });
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:openai", OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a" },
      probes: probes(true, true),
    })).toEqual({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" });
    // A pinned env rung whose key is absent is honest about it.
    expect(await resolveDevCredential({
      env: { VENDO_DEV_CREDENTIAL: "env-key:openai" },
      probes: probes(true, true),
    })).toEqual({ rung: "none" });
  });

  it("describes every rung in one human line", () => {
    expect(describeDevCredential({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }))
      .toContain("ANTHROPIC_API_KEY");
    expect(describeDevCredential({ rung: "claude-session" })).toContain("Claude Code session");
    expect(describeDevCredential({ rung: "codex-session" })).toContain("Codex session");
    expect(describeDevCredential({ rung: "vendo-cloud" })).toContain("VENDO_API_KEY");
    expect(describeDevCredential({ rung: "none" })).toContain("no model credential");
  });
});

describe("session-rung consent", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendo-dev-consent-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips consent under .vendo/data (gitignored, per machine)", async () => {
    expect(await readDevSessionConsent(root)).toBeNull();
    expect(await hasSessionConsent(root, "claude-session", {})).toBe(false);
    await writeDevSessionConsent(root, "claude-session");
    const consent = await readDevSessionConsent(root);
    expect(consent?.rung).toBe("claude-session");
    expect(await hasSessionConsent(root, "claude-session", {})).toBe(true);
    // Consent is per rung: a codex rung is not covered by claude consent.
    expect(await hasSessionConsent(root, "codex-session", {})).toBe(false);
  });

  it("accepts VENDO_DEV_ALLOW_SESSIONS=1 as non-interactive consent", async () => {
    expect(await hasSessionConsent(root, "codex-session", { VENDO_DEV_ALLOW_SESSIONS: "1" })).toBe(true);
  });
});
