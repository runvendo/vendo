/**
 * `automations()` — the automations pack.
 *
 * The honest carve-out first: **triggers and scheduling are platform lifecycle,
 * not pack content** (architecture §5). Arming an app's trigger, the tick, the
 * host event seam, the webhook door, the run records — that is the whole
 * `AutomationsEngine` surface, it belongs to the runtime, and it is composed
 * unconditionally. A pack contributes *over* that lifecycle; it never arms it,
 * and leaving this pack out of `packs:` therefore cannot switch scheduling off.
 *
 * What is left for a pack to contribute today is one judgment rule: THE LAW of
 * §12, restated so the reviewer applies it to what an app is *planning* to do at
 * build time, not just to what the runtime refuses to project at run time. It
 * catches "email everyone on Friday" while it is still a plan and says so in
 * plain language, instead of letting the person find out when a run fails.
 *
 * Grants-as-approval and the consumer-voice run history are the parked
 * automations-pack brainstorm and are deliberately NOT here.
 */
import type { Pack } from "@vendoai/core";
import { definePack } from "./define.js";

export const AUTOMATIONS_PACK_NAME = "automations";

export const UNATTENDED_IRREVERSIBILITY_RULE =
  "Work that runs while nobody is watching may read and write, but it must never move money, message a person, or delete anything — not with a limit, not with an approval. An app that schedules one of those is wrong even if it looks careful: the honest shape is that the scheduled part PREPARES and a person sends, with the real amounts and recipients in front of them.";

export const automations = (): Pack => definePack({
  name: AUTOMATIONS_PACK_NAME,
  checks: [{
    name: "unattended-irreversibility",
    kind: "judgment",
    rule: UNATTENDED_IRREVERSIBILITY_RULE,
  }],
});
