import { describe, expect, it } from "vitest";
import { composioToolRisk } from "./composio-risk.js";

/** 04-actions §3 — Composio risk from UPSTREAM FACTS ONLY. The slug-verb map
 * is gone (risk-grading redesign D1): a name grades nothing, so an untagged
 * tool is `ungraded` and the guard asks about it until the judge or a human
 * grades it. overrides.json still wins downstream (registry mergeOverride). */
describe("composioToolRisk", () => {
  it("trusts Composio destructive/read-only hint tags", () => {
    expect(composioToolRisk(["readOnlyHint"])).toBe("read");
    expect(composioToolRisk(["destructiveHint"])).toBe("destructive");
  });

  it("lets destructive beat a stale read-only hint", () => {
    expect(composioToolRisk(["readOnlyHint", "destructiveHint"])).toBe("destructive");
  });

  it("grades an untagged tool ungraded — a slug is a NAME, and names grade nothing", () => {
    // Every one of these used to be graded from its verb. None of them is a
    // fact: `GMAIL_GET_DELETED_MESSAGES` reads, `GITHUB_UPDATE_ISSUE` writes,
    // and no word list can tell you which without reading the tool.
    for (const tags of [undefined, [], ["updateHint", "important"]]) {
      expect(composioToolRisk(tags)).toBe("ungraded");
    }
  });
});
