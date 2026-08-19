import { z } from "zod";
import { principalSchema, type Principal } from "./principal.js";
import type { Json } from "./ids.js";

/** What the meter counts. `message` is one user turn; `generation` is one app
    the agent built. Both are things a person does, never tokens or calls — a
    host writes its policy in the units it sells in. */
export type LimitAction = "message" | "generation";

export const limitActionSchema = z.enum(["message", "generation"]) satisfies z.ZodType<LimitAction>;

/** The stretch of usage one `count` covers. The three durations are ANDed into
    a single lookback and `since` names an instant floor instead; omit all four
    and the count is all-time.

    `pool` counts the whole shared bucket rather than the one user — a seat pool,
    a team, an org — and is only answerable for a pool the user is actually in
    ({@link LimitUser.pools}). Every org the host asserts in
    `RunContext.memberships` is one of those pools already, named `org:<orgId>`
    (§9.2's principal encoding, the same string an app grant names it by), so an
    org-wide cap needs nothing wired for it. */
export interface LimitWindow {
  days?: number;
  hours?: number;
  minutes?: number;
  since?: Date;
  pool?: string;
}

export const limitWindowSchema = z.object({
  days: z.number().optional(),
  hours: z.number().optional(),
  minutes: z.number().optional(),
  since: z.date().optional(),
  pool: z.string().optional(),
}).passthrough() satisfies z.ZodType<LimitWindow>;

/** What a policy answers with. `true`/`false` is the whole grammar; the object
    form exists only to carry the sentence the user reads when denied, so there
    is deliberately no `{ allow: true }` — allowing has nothing to say. */
export type LimitDecision = boolean | { allow: false; message?: string };

export const limitDecisionSchema = z.union([
  z.boolean(),
  z.object({ allow: z.literal(false), message: z.string().optional() }).passthrough(),
]) satisfies z.ZodType<LimitDecision>;

/** Who the policy is deciding about — the {@link Principal} the request
    resolved to, plus the host-asserted profile the same resolve produced.

    `facts` is the host's own bag (plan, role, tenure, …) and is what a tiered
    policy branches on; `pools` are the shared buckets this user draws from,
    and naming one in a {@link LimitWindow} is how a policy counts a team's
    usage rather than a person's. */
export interface LimitUser extends Principal {
  facts?: Record<string, Json>;
  pools?: string[];
}

export const limitUserSchema = principalSchema.extend({
  facts: z.record(z.unknown()).optional(),
  pools: z.array(z.string()).optional(),
}) satisfies z.ZodType<LimitUser>;

/** The host's policy, asked once before each metered action. Vendo counts;
    this decides.

    `count` is a meter reader already bound to THIS user, so a policy never
    names a subject and can never read another person's usage by accident. It
    is a callback and not a number because most policies read the meter once,
    for one window, and pre-computing every window a policy might ask about
    would be a query per action per call. */
export type LimitsCallback = (input: {
  user: LimitUser;
  action: LimitAction;
  count: (action: LimitAction, window?: LimitWindow) => Promise<number>;
}) => Promise<LimitDecision> | LimitDecision;
