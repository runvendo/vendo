/**
 * The `building-apps` skill. Prose is not testable, but the things the contract
 * makes load-bearing are: that it is a real SKILL.md, that it teaches write-early
 * / write-per-section, and that it points at its references instead of inlining
 * them.
 */
import { createTurnSkills, hostSkillFiles, renderSkillMd, type SkillsFs } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildingAppsSkill } from "../../src/server/skills/building-apps.js";

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

  it("carries no property, flag, or key that we would have to interpret", () => {
    // A skill is {name, description, body} plus companion FILES — data the
    // projection copies to disk, never a directive we read.
    expect(Object.keys(buildingAppsSkill).sort()).toEqual(["body", "description", "files", "name"]);
    expect(Object.keys(buildingAppsSkill.files ?? {})).toEqual(["references/format.md"]);
  });
});

describe("it teaches write-early, write-per-section", () => {
  it("names the writer's own hands as the mechanism, and no retired artifact", () => {
    // The basename is the companion reference's business (`app.tsx`, held there
    // to the seam's watched list); the BODY's job is that the hand doing the
    // writing is the reader's own.
    expect(body).toMatch(/You write the screen file yourself/);
    expect(body).not.toContain(".vendo");
  });

  it("says the screen file is saved again per section, and that one big write is worse", () => {
    expect(body).toContain("after every section you finish");
    expect(body.toLowerCase()).toContain("at the end");
  });

  it("says the checks ride every save and the findings come back on it", () => {
    // The floor is automatic: nothing reaches the screen unchecked, and what the
    // checks find is handed back rather than asked for. So the teaching is READ
    // IT, at the save that made the mistake — one section old instead of a whole
    // app old.
    const writeEarly = body.split("## Write early")[1]?.split("## Know the data")[0] ?? "";
    expect(writeEarly).toMatch(/Every save is checked on its way to the screen/);
    expect(writeEarly).toMatch(/what the checks find\s+comes back to you/);
    expect(writeEarly).toMatch(/they name exactly what\s+to fix/);
  });

  it("never names a `validate` tool, because one reader does not have one", () => {
    // The screen agent's loadout has no `validate` verb — every save is checked
    // for it and a mandatory check closes the build.
    expect(body).not.toContain("validate");
  });

  it("makes standing errors the bar for reporting done, and fixes by editing in place", () => {
    expect(body).toMatch(/not done while a save's errors stand/i);
    expect(body).toMatch(/Not "mostly clean"/);
    expect(body).toMatch(/editing the text in place, never by rewriting\s+the file/i);
    expect(body).toMatch(/exactly one\s+place/);
  });

  it("teaches the honest hole rather than data it made up", () => {
    // The one thing no compiler can catch — a part standing in for data the
    // product does not have.
    expect(body).toMatch(/A hole is a `<Disclaimer>`/);
    expect(body).toMatch(/never a chart of zeros/i);
  });

  it("grounds the data in the declared output schema before any call", () => {
    expect(body).toMatch(/output schema off the tool listing/i);
    expect(body).toMatch(/Call the query once/);
  });
});

describe("it points at the references instead of inlining them", () => {
  it("names the companion format reference at a path that resolves on a real machine", () => {
    // The mount is a WORKSPACE path (`/host/skills/...`), and on disk it lands
    // under the machine's root — `/workspace/host/...` in a box, a temp dir on
    // `machine: "local"` — which is also the session's cwd. So the body says the
    // path RELATIVE to that root; an absolute `/host/...` exists on neither leg.
    expect(body).toContain("`host/skills/building-apps/references/format.md`");
    expect(body).not.toContain("/host/skills/");
    expect(Object.keys(hostSkillFiles([buildingAppsSkill])))
      .toContain("/host/skills/building-apps/references/format.md");
    // And it says the same thing the other way, for a reader who only knows it
    // has a skill directory.
    expect(body).toMatch(/`references\/format\.md` beside this skill/);
  });

  it("names the component reference directory, relative for the same reason", () => {
    // The one place the per-component files are pointed at: the manual stopped
    // repeating it, so a lost pointer here is a lost pointer everywhere.
    expect(body).toContain("`host/components/`");
    expect(body).not.toContain("/host/components/");
  });

  it("says the builder's own hands are the mechanism, so no app tool is hunted for", () => {
    // Live 2026-08-03 the model spent a tool search looking for an app-creation
    // tool. `claudeCode()` withholds `vendo_make` on purpose
    // (toolSurface.withhold) — and `vendo()` does NOT, so the sentence is
    // conditional: an absolute "there is no such tool" would be a lie to the
    // other reader of this same body.
    expect(body).toMatch(/If your tool list has no app-creation or app-edit tool, that is\s+deliberate/);
    expect(body).toMatch(/Do not go searching for a tool that builds the app for you/);
  });
});
