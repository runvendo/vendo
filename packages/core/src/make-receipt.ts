/**
 * What `vendo_make` hands back — contract §3.1.
 *
 * The old tools returned the entire `AppDocument`: the tree, the island sources,
 * the storage declarations, the machine reference. So a calling agent was handed
 * UI and had to be trusted not to describe it, retell it, or invent from it — and
 * a model handed a tree will eventually talk about the tree. Pixels go server →
 * slot; the agent only ever gets words.
 *
 * Four fields, and the laws that go with them:
 *
 * 1. **Never UI.** No tree, no payload, no URL, no component names. The screen
 *    arrives on its own channel; this says only that it is coming.
 * 2. **`say` is one line the agent can utter verbatim.** Consumer voice. No time
 *    estimates, no cost, no "would you like me to…".
 * 3. **`"building"` is an honest answer.** An escalated build is not finished when
 *    the call returns, and pretending otherwise is what makes an agent narrate a
 *    screen that is not there yet.
 * 4. **No consent ceremony.** Cost governance is host config, never a question
 *    asked here.
 */
import { z } from "zod";
import { appIdSchema, type AppId } from "./ids.js";

/** Contract §3.1 */
export interface MakeReceipt {
  id: AppId;
  /** The app's name, in human words — never a slug or an identifier. */
  title: string;
  status: "ready" | "building" | "failed";
  /** ONE speakable line, consumer voice. */
  say: string;
}

/** Contract §3.1 */
export const makeReceiptSchema = z.object({
  id: appIdSchema,
  title: z.string().min(1),
  status: z.enum(["ready", "building", "failed"]),
  say: z.string().min(1),
}).passthrough() satisfies z.ZodType<MakeReceipt>;
