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
  it("tells the harness to run it in a fresh subagent, naming the SDK's own door", () => {
    expect(body).toContain("fresh subagent");
    expect(body).toContain("`Task`");
  });

  it("staffs one worker per group through that same door", () => {
    expect(body).toMatch(/one `Task` per group/);
  });

  it("names `Task` CONDITIONALLY, because one reader of this body has no such tool", () => {
    // The same text is read by `claudeCode()` (which has `Task`) and by
    // `vendo()`'s hired specialist, which is handed no hiring tool at all —
    // depth is bounded at one. An unconditional order is a lie to that reader,
    // so both mentions carry the condition and the body says what to do without.
    expect(body).toMatch(/`Task`, where you have one|`Task` per group[^.]*where you have that tool/);
    expect(body).toMatch(/no\s+way to delegate, do the job yourself/i);
    expect(body).toMatch(/Without one, fill the groups yourself/i);
  });

  it("carries the user's ask into the brief verbatim", () => {
    expect(body).toContain("verbatim");
    expect(body).toMatch(/paraphrase/i);
  });

  it("carries no property, flag, or key that we would have to interpret", () => {
    // A pack skill is {name, description, body} plus companion FILES — data the
    // projection copies to disk, never a directive we read. If delegation ever
    // became a field, this is what would catch it.
    expect(Object.keys(buildingAppsSkill).sort()).toEqual(["body", "description", "files", "name"]);
    expect(Object.keys(buildingAppsSkill.files ?? {})).toEqual(["references/format.md"]);
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

  it("validates after EVERY save, not once at the end", () => {
    // The spec's law: `validate` runs on every save of a hot-path file. Step 5 is
    // the final gate, not the only run — a plan that names a tool which does not
    // exist would otherwise be found after the whole app was built on it.
    const writeEarly = body.split("## Write early")[1]?.split("## 1.")[0] ?? "";
    // The plan save, and every per-group app save.
    expect(writeEarly).toMatch(/Run `validate` on it right there/);
    expect(writeEarly).toMatch(/Run `validate` on every one of those\s+saves/);
    // Step 5 stays the final gate.
    expect(body).toMatch(/Run `validate` on the app document one last time/);
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

  it("makes a clean validate the condition for reporting done (D4/D7's review floor)", () => {
    // With the engine off this surface, this sentence IS the check between a
    // guess and a shipped app.
    expect(body).toMatch(/not done until `validate` comes back clean/i);
  });

  it("teaches never inventing data and never doing the arithmetic itself", () => {
    expect(body).toMatch(/Never do the arithmetic yourself/i);
    expect(body).toContain("sum(transactions.amount_cents)");
    expect(body).toMatch(/made-up figure/i);
  });

  it("forbids baking in a value it computed or fetched", () => {
    expect(body).toMatch(/never paste in a value you fetched/i);
    expect(body).toMatch(/right on the screen you built it on/i);
  });

  it("forbids specifying fonts, colours, or branding", () => {
    expect(body).toMatch(/Never specify a font, a colour/i);
    expect(body).toMatch(/components already carry/i);
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
    expect(body).toContain("mcp__vendo__validate");
    expect(body).toContain("mcp__vendo__host_listTransactions");
    expect(body).toMatch(/if a bare name comes back as no such\s+tool, look for the prefixed one/);
  });

  it("says the builder's own hands are the mechanism, so no app tool is hunted for", () => {
    // Live 2026-08-03 the model spent a tool search looking for an app-creation
    // tool. `claudeCode()` withholds `vendo_apps_create`/`_edit` on purpose
    // (toolSurface.withhold) — and `vendo()` does NOT, so the sentence is
    // conditional, like the delegation one: an absolute "there is no such tool"
    // would be a lie to the other reader of this same body.
    expect(body).toMatch(/If your tool list has no app-creation or app-edit tool, that is\s+deliberate/);
    expect(body).toMatch(/Do not go searching for a tool that builds the app for you/);
  });

  it("names the app directory shape the render seam actually watches", () => {
    // `/user|orgs/…/apps/app_<id>/{plan,app}.vendo` — an id that does not start
    // with `app_` paints nothing, which is the failure this line prevents.
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
    expect(body).toMatch(/Never "wrote app\.vendo"/);
  });
});
