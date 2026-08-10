/**
 * THE LAW (§12), restated for the checking floor.
 *
 * The runtime already refuses to project an irreversible tool onto an unattended
 * run. This is the same law applied one step earlier — to what an app is
 * PLANNING to do at build time — so "email everyone on Friday" is caught while it
 * is still a plan and answered in plain language, instead of the person finding
 * out when a run fails.
 *
 * A judgment rule rather than a fact check: only a reader can tell that a
 * scheduled step moves money or messages a person, so it joins the reviewer's
 * rubric as its own line.
 */
import type {
  Check,
} from "@vendoai/apps/contract";

export const UNATTENDED_IRREVERSIBILITY_RULE =
  "Work that runs while nobody is watching may read and write, but it must never move money, message a person, or delete anything — not with a limit, not with an approval. An app that schedules one of those is wrong even if it looks careful: the honest shape is that the scheduled part PREPARES and a person sends, with the real amounts and recipients in front of them.";

/** The floor's automations check, mounted with the automations subsystem. */
export const unattendedIrreversibilityCheck: Check = {
  name: "unattended-irreversibility",
  kind: "judgment",
  rule: UNATTENDED_IRREVERSIBILITY_RULE,
};
