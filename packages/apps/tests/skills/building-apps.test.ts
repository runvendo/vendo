/**
 * The `building-apps` skill. Prose is not testable, but the things the contract
 * makes load-bearing are: that it is a real SKILL.md, that the delegation advice
 * is a sentence in the BODY rather than machinery, that it teaches write-early /
 * write-per-section, and that it carries the consumer-voice register.
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
});

describe("delegation is advice in the body, never machinery", () => {
  it("tells the harness to run it in a fresh subagent, naming the SDK's own door", () => {
    expect(body).toContain("fresh subagent");
    expect(body).toContain("`Task`");
  });

  it("names `Task` CONDITIONALLY, because one reader of this body has no such tool", () => {
    // The same text is read by `claudeCode()` (which has `Task`) and by
    // `vendo()`'s hired specialist, which is handed no hiring tool at all —
    // depth is bounded at one. An unconditional order is a lie to that reader,
    // so the mention carries the condition and the body says what to do without.
    expect(body).toMatch(/`Task` tool, where you have one/);
    expect(body).toMatch(/no\s+way to delegate, do the job\s+yourself/i);
  });

  it("carries the user's ask into the brief verbatim", () => {
    expect(body).toContain("verbatim");
    expect(body).toMatch(/paraphrase/i);
  });

  it("carries no property, flag, or key that we would have to interpret", () => {
    // A skill is {name, description, body} plus companion FILES — data the
    // projection copies to disk, never a directive we read. If delegation ever
    // became a field, this is what would catch it.
    expect(Object.keys(buildingAppsSkill).sort()).toEqual(["body", "description", "files", "name"]);
    expect(Object.keys(buildingAppsSkill.files ?? {})).toEqual(["references/format.md"]);
  });
});

describe("it teaches write-early, write-per-section", () => {
  it("names the writer's own hands as the mechanism, and no retired artifact", () => {
    // The basename is the companion reference's business (`app.tsx`, held there
    // to the seam's watched list); the BODY's job is that the hand doing the
    // writing is the reader's own. The `.vendo` dialect is retired as the
    // artifact, so a body that still taught it would send a model saving a file
    // nothing compiles.
    expect(body).toMatch(/You write the screen file yourself/);
    expect(body).not.toContain(".vendo");
  });

  it("says the screen file is saved again per section, and that one big write is worse", () => {
    expect(body).toContain("after every section you finish");
    expect(body.toLowerCase()).toContain("at the end");
  });

  it("says the checks ride every save and the findings come back on it", () => {
    // The floor is automatic now: nothing reaches the screen unchecked, and what
    // the checks find is handed back rather than asked for. So the teaching is
    // READ IT, at the save that made the mistake — one section old instead of a
    // whole app old.
    const writeEarly = body.split("## Write early")[1]?.split("## 1.")[0] ?? "";
    expect(writeEarly).toMatch(/Every save is checked on its way to the screen/);
    expect(writeEarly).toMatch(/what the checks find\s+comes back to you/);
    expect(writeEarly).toMatch(/they name exactly what\s+to fix/);
  });

  it("never names a `validate` tool, because one reader does not have one", () => {
    // The screen agent's loadout has no `validate` verb — every save is checked
    // for it and a mandatory check closes the build. A body that named the verb
    // would spend that reader's steps hunting a tool that is not there, and a
    // skill body is copied to a harness verbatim rather than translated.
    expect(body).not.toContain("validate");
  });
});

describe("it carries the v2 pattern", () => {
  it("teaches reading the findings, then fixing by editing rather than rewriting", () => {
    expect(body).toMatch(/The checks read like a compiler/);
    expect(body).toMatch(/editing the text in place, never by rewriting the file/i);
    expect(body).toMatch(/exactly one place/);
  });

  it("makes standing errors the bar for reporting done (D4/D7's review floor)", () => {
    // The checks run whether or not anybody asks; what is left to the writer is
    // not calling them but refusing to report done over what they said.
    expect(body).toMatch(/not done while a save's errors stand/i);
    expect(body).toMatch(/Not "mostly clean"/);
  });

  it("teaches the honest hole rather than data it made up", () => {
    // The arithmetic prohibition and its `sum(rows, "field")` example retired with
    // the closed expression-call vocabulary: a screen is TSX now, so the model
    // writes `rows.reduce(...)` itself and the checks type it. What survives here
    // is the half no compiler can catch — a part standing in for data the product
    // does not have.
    expect(body).toMatch(/A hole is a `<Disclaimer>`/);
    expect(body).toMatch(/never a chart of zeros/i);
    expect(body).toMatch(/Bind the rows as they come/);
  });

  it("keeps every choice about which parts to name, never about styling", () => {
    // The font/colour prohibition moved to the companion reference, where the
    // no-`className`, no-CSS law sits beside the components that carry the theme.
    // What the BODY owes is the frame that prohibition rests on.
    expect(body).toMatch(/never about CSS/);
  });

  it("grounds the data in the declared output schema before any call", () => {
    expect(body).toMatch(/output schema off the tool listing/i);
    expect(body).toMatch(/Call the query once/);
  });

  it("keeps ask_user as ONE door, asked once", () => {
    // The tool's real name (core's ASK_USER_TOOL) — a skill body is copied to
    // disk verbatim, so a name it gets wrong is a tool that does not exist.
    expect(body).toContain("ask_user");
    expect(body).toMatch(/once/);
    expect(body).toMatch(/do not ask twice/i);
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
    expect(body).toContain("`host/components/`");
    expect(body).toContain("`host/components/<Name>.md`");
    expect(body).not.toContain("/host/components/");
  });

  it("says a namespaced tool listing means the same bare names it uses", () => {
    // A skill body is copied verbatim, and the `claudeCode()` leg reaches these
    // tools over the MCP door, where they list as `mcp__vendo__<tool>`. Live
    // 2026-08-03 the model called a host tool bare TWICE, got "No such tool
    // available", and only then found the prefix — so the sentence names the
    // shape and says what to do when a bare name fails.
    expect(body).toContain("mcp__vendo__ask_user");
    expect(body).toContain("mcp__vendo__host_listTransactions");
    expect(body).toMatch(/if a bare name comes back as no such\s+tool, look for the prefixed one/);
  });

  it("says the builder's own hands are the mechanism, so no app tool is hunted for", () => {
    // Live 2026-08-03 the model spent a tool search looking for an app-creation
    // tool. `claudeCode()` withholds `vendo_make` on purpose
    // (toolSurface.withhold) — and `vendo()` does NOT, so the sentence is
    // conditional, like the delegation one: an absolute "there is no such tool"
    // would be a lie to the other reader of this same body.
    expect(body).toMatch(/If your tool list has no app-creation or app-edit tool, that is\s+deliberate/);
    expect(body).toMatch(/Do not go searching for a tool that builds the app for you/);
  });

  it("names the app directory shape the render seam actually watches", () => {
    // `/user|orgs/…/apps/app_<id>/app.tsx` — an id that does not start with
    // `app_` paints nothing, which is the failure this line prevents.
    expect(body).toContain("user/apps/app_");
    expect(body).toMatch(/must start with `app_`/);
  });
});

describe("it carries the consumer voice register", () => {
  it("tells the builder to name the real arguments rather than summarize them", () => {
    expect(body).toContain("Friendly is not vague");
    expect(body).toContain("$1,400");
  });

  it("forbids saying file and tool names to the person", () => {
    expect(body).toMatch(/Never "wrote the screen file" or "called maple_invoices_list"/);
  });
});
