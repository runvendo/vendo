/**
 * A pack written the way a third party writes one.
 *
 * It lives OUTSIDE `packages/` deliberately: if the public interface is not
 * enough to author a real pack from out here, it is not enough for anyone, and
 * `apps()` would be relying on something a customer cannot reach.
 *
 * The rules it obeys, which are the whole test:
 *
 * - It imports from `@vendoai/vendo` only — the published root entry. No
 *   `@vendoai/core`, no `@vendoai/apps`, no deep path into the monorepo.
 * - It is ONE plain value with four slots. No registration call, no lifecycle
 *   hook, no config surface of its own.
 * - It is import-safe on the server: the module is imported twice (server for
 *   tools/checks/skills, client for components), so nothing here touches a
 *   browser global at import time.
 */
import { definePack } from "@vendoai/vendo";

/** Stands in for the host component a real pack would ship. The server ignores
 *  `component` entirely; the client mounts it. */
const RetentionBadge = { displayName: "RetentionBadge" };

export const RETENTION_RULE =
  "Every total on screen has to say which report it came from, in words the person reading it would use.";

/** What a fact check found, so the test can prove the check really ran rather
 *  than that the floor merely registered it. */
export const UNMASKED_ACCOUNT = 'shows a full account number — mask it to the last four digits';

export const complianceReports = definePack({
  name: "compliance-reports",

  tools: [{
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
  }],

  skills: [{
    name: "building-compliance-reports",
    description: "Build a compliance report someone can hand to an auditor without editing it first.",
    body: `# Building a compliance report

Run me in a fresh subagent — this reads a lot and writes one file.

Every total cites the report it came from. Account numbers are masked to the last
four digits, always, including in a heading. If a figure cannot be traced back to
a report, leave it out and say so plainly.
`,
  }],

  checks: [
    {
      name: "no-unmasked-accounts",
      kind: "fact",
      run: async ({ document }) => {
        const printed = JSON.stringify(document.tree ?? {});
        return /\b\d{9,}\b/.test(printed)
          ? [{ severity: "block", where: "document", message: UNMASKED_ACCOUNT }]
          : [];
      },
    },
    { name: "totals-cite-their-report", kind: "judgment", rule: RETENTION_RULE },
  ],

  components: {
    RetentionBadge: {
      component: RetentionBadge,
      description: "A badge showing how long a report is retained.",
      examples: ['<RetentionBadge years={7}/>'],
    },
  },
});
