/**
 * Capability written the way a third party writes it.
 *
 * It lives OUTSIDE `packages/` deliberately: if the public interface is not
 * enough to author this from out here, it is not enough for anyone, and app
 * generation would be relying on something a customer cannot reach.
 *
 * The rules it obeys, which are the whole test:
 *
 * - It imports from `@vendoai/vendo` only — the published root entry. No deep
 *   path into the monorepo.
 * - There is no wrapper. Each piece is a plain value going to the config key
 *   that already existed for its kind: tools to `tools`, skills to `skills`,
 *   checks to `apps.checks`, components to `catalog`. No registration call, no
 *   lifecycle hook, no noun to learn.
 * - Nothing here touches a browser global at import time.
 */
import type { Check, Skill, ToolDefinition } from "@vendoai/vendo";

/** Stands in for the host component a real integration would ship. The server
 *  ignores `component` entirely; the client mounts it. */
const RetentionBadge = { displayName: "RetentionBadge" };

export const RETENTION_RULE =
  "Every total on screen has to say which report it came from, in words the person reading it would use.";

/** What a fact check found, so the test can prove the check really ran rather
 *  than that the floor merely registered it. */
export const UNMASKED_ACCOUNT = 'shows a full account number — mask it to the last four digits';

export const complianceTools: ToolDefinition[] = [{
  name: "check_report",
  title: "Check a report",
  description: "Check one compliance report and answer with its status.",
  inputSchema: {
    type: "object",
    properties: { reportId: { type: "string", minLength: 1 } },
    required: ["reportId"],
    additionalProperties: false,
  },
  risk: "read",
  execute: async (input) => {
    const { reportId } = input as { reportId?: string };
    if (typeof reportId !== "string" || reportId === "") {
      throw new Error("check_report needs a reportId");
    }
    return { reportId, status: "clean", checkedAt: "2026-07-30T00:00:00.000Z" };
  },
}];

export const complianceSkills: Skill[] = [{
  name: "building-compliance-reports",
  description: "Build a compliance report someone can hand to an auditor without editing it first.",
  body: `# Building a compliance report

Run me in a fresh subagent — this reads a lot and writes one file.

Every total cites the report it came from. Account numbers are masked to the last
four digits, always, including in a heading. If a figure cannot be traced back to
a report, leave it out and say so plainly.
`,
}];

export const complianceChecks: Check[] = [
  {
    name: "no-unmasked-accounts",
    kind: "fact",
    run: async ({ renderedTree }) => {
      const printed = JSON.stringify(renderedTree ?? {});
      return /\b\d{9,}\b/.test(printed)
        ? [{ severity: "block", where: "document", message: UNMASKED_ACCOUNT }]
        : [];
    },
  },
  { name: "totals-cite-their-report", kind: "judgment", rule: RETENTION_RULE },
];

export const complianceComponents = {
  RetentionBadge: {
    component: RetentionBadge,
    description: "A badge showing how long a report is retained.",
    examples: ['<RetentionBadge years={7}/>'],
  },
};
