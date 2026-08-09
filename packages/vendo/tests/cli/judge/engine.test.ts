import { describe, expect, it } from "vitest";
import type { ExtractionHarness } from "../../../src/cli/extract/harness.js";
import { resolveJudgmentEngine, selectJudgmentEngines } from "../../../src/cli/judge/engine.js";

/** A harness whose availability answer is scripted. `id` drives the family
 *  mapping, so the real ENGINE_FAMILIES table is what the tests exercise. */
function harness(id: string, credential: string | null): ExtractionHarness {
  return {
    id,
    availability: async () => credential,
    run: async () => "{}",
  };
}

const forbidden: ExtractionHarness = {
  id: "forbidden",
  availability: async () => { throw new Error("a keyless pass must never probe an engine"); },
  run: async () => { throw new Error("a keyless pass must never invoke a model"); },
};

describe("selectJudgmentEngines", () => {
  it("sweeps the whole ladder in order, one rung per family", async () => {
    const available = await selectJudgmentEngines({
      root: "/tmp",
      env: {},
      harnesses: [
        harness("claude-agent-sdk", null),
        harness("claude-cli", "your Claude Code login"),
        harness("codex-cli", "your codex login"),
        harness("npx-engine", "your VENDO_API_KEY"),
      ],
    });
    expect(available.map((entry) => entry.family)).toEqual(["claude", "codex", "npx"]);
    expect(available[0]!.credential).toBe("your Claude Code login");
  });

  it("keeps only the FIRST available rung of a family", async () => {
    const available = await selectJudgmentEngines({
      root: "/tmp",
      env: {},
      harnesses: [
        harness("claude-agent-sdk", "the Agent SDK"),
        harness("claude-cli", "your Claude Code login"),
      ],
    });
    expect(available).toHaveLength(1);
    expect(available[0]!.credential).toBe("the Agent SDK");
  });
});

describe("resolveJudgmentEngine", () => {
  it("keyless: null engine, a reason naming both key paths, and NO availability probe", async () => {
    const resolved = await resolveJudgmentEngine({
      root: "/tmp",
      env: {},
      resolveCredential: async () => ({ rung: "none" }),
      harnesses: [forbidden],
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("ANTHROPIC_API_KEY");
    expect(resolved.reason).toContain("VENDO_API_KEY");
  });

  it.each(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"])(
    "%s is a coding-agent credential the gate must honor, even though it serves no product turn",
    async (envVar) => {
      const resolved = await resolveJudgmentEngine({
        root: "/tmp",
        env: { [envVar]: "set" },
        // The real resolver's answer for this env: no runtime model key. The
        // harnesses run on it all the same.
        resolveCredential: async () => ({ rung: "none" }),
        harnesses: [harness("claude-cli", `your ${envVar}`)],
      });
      expect(resolved.engine?.credential).toBe(`your ${envVar}`);
    },
  );

  it("picks the first available rung when no pin is given", async () => {
    const resolved = await resolveJudgmentEngine({
      root: "/tmp",
      env: {},
      resolveCredential: async () => ({ rung: "vendo-cloud" }),
      harnesses: [harness("claude-agent-sdk", null), harness("codex-cli", "your codex login")],
    });
    expect(resolved.engine?.family).toBe("codex");
  });

  it("an --engine pin NEVER falls back, and the reason names what IS available", async () => {
    const resolved = await resolveJudgmentEngine({
      root: "/tmp",
      env: {},
      engine: "codex",
      resolveCredential: async () => ({ rung: "vendo-cloud" }),
      harnesses: [harness("claude-cli", "your Claude Code login"), harness("codex-cli", null)],
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("--engine codex");
    expect(resolved.reason).toContain("never falls back");
    expect(resolved.reason).toContain("--engine claude");
  });

  it("an available --engine pin is honored over an earlier rung", async () => {
    const resolved = await resolveJudgmentEngine({
      root: "/tmp",
      env: {},
      engine: "npx",
      resolveCredential: async () => ({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }),
      harnesses: [harness("claude-cli", "your Claude Code login"), harness("npx-engine", "your VENDO_API_KEY")],
    });
    expect(resolved.engine?.family).toBe("npx");
  });

  it("keyed but no rung installed: null engine with an install-pointing reason", async () => {
    const resolved = await resolveJudgmentEngine({
      root: "/tmp",
      env: {},
      resolveCredential: async () => ({ rung: "vendo-cloud" }),
      harnesses: [harness("claude-cli", null), harness("codex-cli", null)],
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("no judgment engine available");
  });
});
