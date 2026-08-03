/**
 * The `building-apps` skill. Prose is not testable, but the things the contract
 * makes load-bearing are: that it is a real SKILL.md, that the delegation advice
 * is a sentence in the BODY rather than machinery, that it teaches write-early /
 * write-per-group, and that it carries the consumer-voice register.
 */
import { createTurnSkills, hostSkillFiles, renderSkillMd, type SkillsFs } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildingAppsSkill } from "./building-apps.js";

/** A workspace opened with this skill in its read-only `/host` projection. */
const mounted = (): SkillsFs => {
  const files = new Map(Object.entries(hostSkillFiles([buildingAppsSkill])));
  return {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    getAllPaths() { return [...files.keys()]; },
  };
};

const body = buildingAppsSkill.body;

describe("the building-apps skill is a real SKILL.md", () => {
  it("carries a name and a one-line description a ~30-token listing can show", () => {
    expect(buildingAppsSkill.name).toBe("building-apps");
    expect(buildingAppsSkill.description.length).toBeGreaterThan(20);
    expect(buildingAppsSkill.description).not.toContain("\n");
  });

  it("renders as agentskills.io frontmatter plus the body, and loads back verbatim", async () => {
    expect(renderSkillMd(buildingAppsSkill).startsWith("---\nname: \"building-apps\"\n")).toBe(true);
    expect(await createTurnSkills(mounted()).load("building-apps")).toBe(body);
  });
});

describe("delegation is advice in the body, never machinery", () => {
  it("tells the harness to run it in a fresh subagent, in a sentence", () => {
    expect(body).toContain("fresh subagent");
  });

  it("carries no property, flag, or key that we would have to interpret", () => {
    // A pack skill is exactly {name, description, body}. If delegation ever
    // became a field, this is what would catch it.
    expect(Object.keys(buildingAppsSkill).sort()).toEqual(["body", "description", "name"]);
  });
});

describe("it teaches write-early, write-per-group", () => {
  it("names both hot-path files and says the plan lands first", () => {
    expect(body).toContain("plan.vendo");
    expect(body).toContain("app.vendo");
    expect(body).toMatch(/plan\.vendo\*\* first|Save `plan\.vendo` \*\*first\*\*/);
  });

  it("says the app file is saved again per group, and that one big write is worse", () => {
    expect(body).toContain("after every group");
    expect(body.toLowerCase()).toContain("at the end");
  });
});

describe("it carries the v2 pattern", () => {
  it("teaches the blinkered fill workers", () => {
    expect(body).toContain("only");
    expect(body).toMatch(/blinkers/i);
  });

  it("teaches validate then fix by editing, not rewriting", () => {
    expect(body).toContain("validate");
    expect(body).toContain("<Edit>");
    expect(body).toContain("<Old>");
    expect(body).toMatch(/exactly once/);
  });

  it("teaches never inventing data and never doing the arithmetic itself", () => {
    expect(body).toMatch(/Never do arithmetic yourself/i);
    expect(body).toContain("sum(transactions.amount_cents)");
    expect(body).toMatch(/made-up figure/i);
  });

  it("keeps ask_user as ONE door, asked once", () => {
    expect(body).toContain("ask_user");
    expect(body).toMatch(/once/);
    expect(body).toMatch(/do not ask twice/i);
  });
});

describe("it carries the consumer voice register", () => {
  it("tells the builder to name the real arguments rather than summarize them", () => {
    expect(body).toContain("Friendly is not vague");
    expect(body).toContain("$1,400");
  });

  it("forbids saying file and tool names to the person", () => {
    expect(body).toMatch(/Never "wrote app\.vendo"/);
  });
});
