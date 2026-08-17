/**
 * An in-memory automations engine, standing in for the one the umbrella composes.
 *
 * A double is the only option on this side of the line and that is the design:
 * `@vendoai/apps` may import `@vendoai/core` and nothing else, so the seam IS the
 * block boundary and this is the whole of what apps can see through it. What it
 * does NOT fake is the record model — `toTriggerSource` is core's own converter,
 * so a cron this accepts is a cron the real engine accepts. The two sides meeting
 * for real is the e2e fixtures' job.
 */
import {
  toTriggerSource,
  type ApprovalRequest,
  type AutomationId,
  type AutomationRecord,
  type CreateAutomationInput,
  type RunContext,
} from "@vendoai/core";
import type { AutomationsSeam } from "../src/server/runtime/types.js";

export interface FakeAutomations {
  seam: AutomationsSeam;
  /** Every record, by id, newest content wins — the create operation's
   *  replace-by-id rule is the whole reason a redeploy is idempotent. */
  records: Map<AutomationId, AutomationRecord>;
  /** Every input the ONE create operation was handed, in order. A record can
   *  only exist by passing through here, so this list IS the census of
   *  authoring: a door that grew its own create path would produce a record
   *  this never saw. */
  creates: CreateAutomationInput[];
  /** The ids `disable` was called on, in order. */
  disabled: AutomationId[];
}

export const fakeAutomations = (options: {
  /** What `enable` answers. Default: armed, nothing outstanding. */
  enable?: (id: AutomationId) => Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
} = {}): FakeAutomations => {
  const records = new Map<AutomationId, AutomationRecord>();
  const creates: CreateAutomationInput[] = [];
  const disabled: AutomationId[] = [];
  let minted = 0;
  const seam: AutomationsSeam = {
    async create(input, ctx: { principal: RunContext["principal"] }) {
      creates.push(input);
      const id = input.id ?? `atm_fake${minted += 1}`;
      const now = new Date().toISOString();
      const record: AutomationRecord = {
        id,
        owner: input.owner ?? ctx.principal,
        when: toTriggerSource(input.when),
        task: input.task,
        armed: input.armed !== false,
        authoredBy: input.authoredBy,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        createdAt: records.get(id)?.createdAt ?? now,
        updatedAt: now,
      };
      records.set(id, record);
      return record;
    },
    async enable(id) {
      const answer = await (options.enable?.(id) ?? Promise.resolve({ enabled: true, missing: [] }));
      const record = records.get(id);
      if (record !== undefined) records.set(id, { ...record, armed: answer.enabled });
      return answer;
    },
    async disable(id) {
      disabled.push(id);
      const record = records.get(id);
      if (record !== undefined) records.set(id, { ...record, armed: false, disarmedBy: "user" });
    },
    async resolve(ids) {
      // Dead ids drop out, which is the whole of the cleanup an app's list gets.
      return ids.flatMap((id) => {
        const record = records.get(id);
        return record === undefined ? [] : [record];
      });
    },
  };
  return { seam, records, creates, disabled };
};
