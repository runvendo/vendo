import { automationHash, type AutomationRecord, type IsoDateTime } from "@vendoai/core";
import { z } from "zod";
import type { EngineOps } from "./rows.js";

/** Build contract §9.9 — sponsorship lives in its OWN routed collection, never
 *  on the record: the record is the automation's declaration, this is who it
 *  runs as, and two independent facts on one row drift. Engine-internal state
 *  like `automations:captures`, so the generic records door is right here. */
export const SPONSORSHIPS = "automations:sponsorships";

/** The era marker: "this automation has been sponsored at least once", keyed to
 *  the record and carrying NO subject data at all.
 *
 *  It exists because the sponsorship row itself must be erasable: it holds a
 *  person's subject, so `eraseStore.bySubject` collects it (`refs.subject`) —
 *  and a missing row otherwise reads as "never sponsored", which would hand the
 *  automation silently back to its owner the next time it fired. With this
 *  marker, marker-present + row-absent means "the sponsor is gone": the run
 *  stops. `refs` carry only `automation_id`, so a subject erase cannot reach it
 *  and an automation erase collects it. */
export const SPONSORED = "automations:sponsored";

/** Build contract §9.9 — one RECORD, one sponsor. */
export interface Sponsorship {
  automationId: string;
  /** The sponsor's subject. An automation always runs as a named person. */
  sponsor: string;
  /** The sponsor's own display name, as their Principal asserted it at enable.
   *  Captured with their consent in the same moment they arm the automation, so
   *  every surface can say "Dana" instead of `user_dana` without Vendo ever
   *  holding a directory. Absent when the host asserts no display name. */
  display?: string;
  /** {@link automationHash} over what the record DID at mint time. */
  intentHash: string;
  status: "active" | "invalidated";
  reason?: "edit" | "departure";
  invalidatedAt?: IsoDateTime;
}

export const sponsorshipSchema = z.object({
  automationId: z.string(),
  sponsor: z.string(),
  display: z.string().optional(),
  intentHash: z.string(),
  status: z.enum(["active", "invalidated"]),
  reason: z.enum(["edit", "departure"]).optional(),
  invalidatedAt: z.string().optional(),
}) satisfies z.ZodType<Sponsorship>;

/** The tools an automation DECLARES it will use: its steps' host tools, deduped.
 *  A goal declares nothing — its toolset is whatever the registry binds at fire
 *  time, which is not a declaration.
 *
 *  An `fn:` step is dropped because it is not a host tool: it is the app's own
 *  server code, run inside the app's own box, which never sees host credentials
 *  (`packages/apps/src/server/escalation/fn.ts`) — so the host has no descriptor
 *  to grade, no hash to bind, and nothing to consent to. Its authority is the
 *  app's boundary, and the automation's own kill switch is what revokes it. */
export const declaredSurface = (record: AutomationRecord): string[] =>
  record.task.kind !== "steps"
    ? []
    : [...new Set(record.task.steps.map((step) => step.tool).filter((tool) => !tool.startsWith("fn:")))];

/** The intent this record's consent is bound to — core's own content hash, the
 *  SAME one that mints a declaration's default id. One hash, so "this changed"
 *  cannot mean two things. */
export const currentIntentHash = (record: AutomationRecord): string => automationHash(record);

/** The stored sponsorship, or undefined when there is none or the row is
 *  unreadable.
 *
 *  A corrupt row therefore reads as NO row, which the caller resolves against
 *  the {@link SPONSORED} era marker — and since every sponsorship write stamps
 *  that marker, the automation fails CLOSED (it stops) rather than falling back
 *  to running as its owner. That is the intended answer: an unreadable
 *  sponsorship is not evidence that nobody took the automation on. */
export const readSponsorship = async (
  engine: EngineOps,
  automationId: string,
): Promise<Sponsorship | undefined> => {
  const record = await engine.get(SPONSORSHIPS, automationId);
  if (record === null) return undefined;
  const parsed = sponsorshipSchema.safeParse(record.data);
  return parsed.success ? parsed.data : undefined;
};

/** Both refs are load-bearing: the 02-store §5 erase cascade collects generic
 *  rows by `refs.subject` (erasing the sponsor takes their name off the row)
 *  AND by `refs.automation_id` (deleting the record takes its sponsorship with
 *  it). A row that survived either cascade would be a dangling name. */
export const writeSponsorship = async (engine: EngineOps, row: Sponsorship): Promise<void> => {
  await engine.put(SPONSORSHIPS, {
    id: row.automationId,
    data: { ...row },
    refs: { subject: row.sponsor, automation_id: row.automationId },
  });
};

/** Record that this automation is sponsored, without recording WHO. Idempotent. */
export const markSponsored = async (
  engine: EngineOps,
  automationId: string,
  at: IsoDateTime,
): Promise<void> => {
  if (await engine.get(SPONSORED, automationId) !== null) return;
  await engine.put(SPONSORED, {
    id: automationId,
    data: { automationId, since: at },
    refs: { automation_id: automationId },
  });
};

/** Has this automation ever been sponsored? */
export const wasSponsored = async (engine: EngineOps, automationId: string): Promise<boolean> =>
  await engine.get(SPONSORED, automationId) !== null;
