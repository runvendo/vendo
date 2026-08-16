/**
 * Per-user limits: Vendo counts, the host decides.
 *
 * The host's `limits` callback is asked before each metered action and its
 * verdict is honored. Everything else about a limit lives HERE — reading the
 * meter, invoking the policy, recording what an allow spent, and the fail mode —
 * so a choke point is one `gate` call and can never grow its own half of the
 * rule.
 *
 * The fail mode is the load-bearing decision: a policy that throws DENIES. A
 * limits system that fails open stops limiting silently, so the host keeps
 * believing they have a cap while every user is unlimited — strictly worse than
 * a turn that was refused and said so.
 *
 * ADMISSION is the other half, and it is why the policy is asked "before each"
 * action rather than exactly once. The meter is read INSIDE the host's callback
 * and the allow is written after it returns, so on its own that is check-then-do
 * and concurrent actions for one subject can each pass a cap only one of them
 * fits under. `usage.claim` closes it by writing only while every number the
 * policy read still holds; when it does not, the policy is asked AGAIN on fresh
 * numbers rather than admitted on stale ones. An adapter with no `claim` keeps
 * the old check-then-record behavior, which is the bounded overrun and not a
 * silent one.
 */
import {
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  VendoError,
  log,
  type LimitAction,
  type LimitWindow,
  type LimitUser,
  type LimitsCallback,
  type RunContext,
  type StoreOps,
  type ToolRegistry,
  type UsageCountQuery,
  type UsageObservation,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";

/** The decision a choke point acts on — `LimitDecision`'s two forms collapsed to
    one, so no caller re-derives the boolean/object grammar. */
export type LimitVerdict = { allow: true } | { allow: false; message?: string };

export interface Limiter {
  gate(action: LimitAction, ctx: RunContext): Promise<LimitVerdict>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** `UsageCountQuery.since` is required, so "all time" is the epoch. */
const ALL_TIME = new Date(0);

/** How many times a contended admission re-asks the policy before denying.
 *  Small on purpose: losing the reservation means another action for this same
 *  subject landed in the window between the policy's read and this write, which
 *  is bounded by how many are genuinely in flight — a number that does not
 *  reward spinning. Three passes and then the fail-closed answer. */
const ADMISSION_ATTEMPTS = 3;

/** The host's policy, bound to the meter it decides on.
 *
 *  `ops` is the usage family and not the whole `StoreOps` because a limiter
 *  against a store with no meter would read every user as zero — composition
 *  refuses that outright (`composeLimits`), so it cannot arrive here. */
export function createLimiter({ callback, ops }: {
  callback: LimitsCallback;
  ops: NonNullable<StoreOps["usage"]>;
}): Limiter {
  return {
    async gate(action, ctx) {
      const { subject } = ctx.principal;
      const pools = ctx.pools ?? {};
      const user: LimitUser = {
        ...ctx.principal,
        ...(ctx.user === undefined ? {} : { facts: ctx.user }),
        ...(ctx.pools === undefined ? {} : { pools: Object.keys(pools) }),
      };
      /** One pass at the policy: its verdict, and every number it reached that
          verdict on. A pass owns its own observations because a re-ask is
          judged on FRESH numbers — replaying the stale ones that just lost a
          race would re-stake the losing bet. */
      const ask = async (): Promise<{ verdict: LimitVerdict; observed: UsageObservation[] }> => {
        // Kept as the QUERY that produced it, not the number alone: `claim`
        // re-asks the identical question, so a mismatch can only mean the meter
        // moved.
        const seen = new Map<string, UsageObservation>();
        const observe = async (query: UsageCountQuery): Promise<number> => {
          const counted = await ops.count(query);
          const key = JSON.stringify([query.action, query.subject, query.poolKey, query.since.valueOf(), query.until?.valueOf()]);
          // A repeated question stakes its FIRST answer, never its latest. The
          // policy's decision rests on everything it read, so the stake has to
          // span from the earliest read to the write — keeping the latest would
          // narrow the window to the last `await` and quietly accept a meter
          // that moved while the policy was still deciding on it. Same-window
          // counts only grow, so the first answer is also the strictest.
          if (!seen.has(key)) seen.set(key, { query, count: counted });
          return counted;
        };
        // Pre-bound to THIS subject: a policy never names one, so it can never
        // read another person's usage by accident.
        const count = (counted: LimitAction, window?: LimitWindow): Promise<number> => {
          const lookback = (window?.days ?? 0) * DAY + (window?.hours ?? 0) * HOUR
            + (window?.minutes ?? 0) * MINUTE;
          const since = lookback > 0 ? new Date(Date.now() - lookback) : window?.since ?? ALL_TIME;
          if (window?.pool === undefined) return observe({ action: counted, since, subject });
          const poolKey = pools[window.pool];
          // A pool this user is not in is an ERROR, never a zero: answering 0 for
          // a meter that was never resolved silently under-counts every limit
          // written against it, and the deny below is the only safe answer.
          if (poolKey === undefined) {
            throw new VendoError(
              "validation",
              `The limits policy counted the \`${window.pool}\` pool, which this user is not in `
              + `(their pools: ${Object.keys(pools).map((name) => `\`${name}\``).join(", ") || "none"}). `
              + "Pools come from the auth preset's `pools` seam — assert the pool there, or count a pool the user is in.",
            );
          }
          return observe({ action: counted, since, poolKey });
        };

        let decision;
        try {
          decision = await callback({ user, action, count });
        } catch (error) {
          log({
            code: "limits.callback_error",
            level: "error",
            message: `[vendo] the limits policy failed for ${subject}; DENYING the ${action} (a limits policy that fails open stops limiting):`,
            data: { error },
          });
          return { verdict: { allow: false }, observed: [] };
        }
        const verdict: LimitVerdict = decision === true
          ? { allow: true }
          : decision === false ? { allow: false } : decision;
        return { verdict, observed: [...seen.values()] };
      };

      for (let attempt = 1; attempt <= ADMISSION_ATTEMPTS; attempt += 1) {
        const { verdict, observed } = await ask();
        if (!verdict.allow) return verdict;
        // Awaited, not fire-and-forget: the next action's count has to see this
        // one, and a dropped write is a limit that never arrives.
        const event = { subject, action, at: new Date(), poolKeys: Object.values(pools) };
        if (ops.claim === undefined) {
          // The adapter cannot reserve, so this is the check-then-record the
          // meter has always been: concurrent actions for one subject can each
          // pass a cap only one of them fits under, bounded by how many are
          // genuinely in flight.
          await ops.record(event);
          return { allow: true };
        }
        // The verdict was reached against numbers that must still be true when
        // the action lands. If they are, this admits and writes in one step; if
        // they are not, nothing was written and the policy decides again.
        if (await ops.claim(event, observed)) return { allow: true };
      }
      // Every pass was outrun. DENY, on the same rule a throwing policy denies
      // under: the cap this action would land over is real, and admitting it
      // because the meter is busy is the overrun with extra steps.
      log({
        code: "limits.admission_contended",
        level: "warn",
        message: `[vendo] the meter moved under the limits policy ${ADMISSION_ATTEMPTS} times running for ${subject}; `
          + `DENYING the ${action} rather than admitting it over a cap`,
        data: { subject, action },
      });
      return { allow: false };
    },
  };
}

/** What the AGENT is told when a build was refused — FACTS, like every other
 *  refusal on this registry (`ask-user.ts`, apps' `FORBIDDEN_FACTS`): what did
 *  not happen, the host's own sentence when the policy wrote one, and that the
 *  call is not worth repeating. The person is told by the card beside it. */
const generationDenied = (message: string | undefined): string =>
  "The app was not built: this user has reached a limit the host's own policy sets."
  + `${message === undefined ? "" : ` The host says: ${message}`}`
  + " Calling again gets the same answer, and there is no other way to build it.";

/** The generation choke — `vendo_make`, the ONE door an app is built through,
 *  asked before it runs. A deny answers the agent with the same `blocked`
 *  outcome every other refusal on this registry uses, and raises the card the
 *  person reads on the call's own stream, so the turn CARRIES ON: unlike a
 *  refused message, a refused generation is something the agent can talk about.
 *
 *  Wrapped at composition rather than inside `@vendoai/apps`, so a deployment
 *  with no `limits` key executes the registry it always executed. */
export const limitGenerations = (tools: ToolRegistry, limiter: Limiter): ToolRegistry => ({
  ...tools,
  execute: async (call, ctx) => {
    // `ctx.trigger` is the AUTOMATION VENUE, and the only honest sign of it: the
    // engine mints it per firing (`automations/src/sponsorship-gate.ts`'s
    // baseRunContext) and the wire's context resolution never writes one. A
    // firing is nobody's request, has no per-user meter to spend, and was never
    // in this feature's scope — gated, every host who set `limits` silently lost
    // every automation build. NOT keyed on a missing subject or empty pools:
    // those are also what a request whose identity did not resolve looks like,
    // and that one must keep failing closed below.
    if (call.tool !== VENDO_MAKE_TOOL || ctx.trigger !== undefined) return tools.execute(call, ctx);
    const verdict = await limiter.gate("generation", ctx);
    if (verdict.allow) return tools.execute(call, ctx);
    (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM]?.({
      id: `vendo-limit:${call.id}`,
      part: { type: "data-vendo-limit", ...(verdict.message === undefined ? {} : { message: verdict.message }) },
    });
    return { status: "blocked", reason: generationDenied(verdict.message) };
  },
});

/** The `limits` key, composed ONLY when the host set one — unset leaves no
 *  limiter, and every choke point then costs a single undefined check.
 *
 *  `StoreOps.usage` is optional (`store.ts`: a store with nowhere to meter says
 *  so by omitting the family), so a policy against a meterless store is refused
 *  HERE rather than enforced against counts that are all zero. */
export const composeLimits = (composition: VendoComposition): Pick<VendoComposition, "limiter"> => {
  const { config, ops } = composition;
  if (config.limits === undefined) return { limiter: undefined };
  if (ops?.usage === undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ limits }) needs a store that can count, and this deployment's store has no usage meter: "
      + "every count would read 0, so no limit would ever be reached and every user would be unlimited. "
      + "Use the default store (or any store on schema v10+ — Vendo Cloud, your own Postgres via createStore), "
      + "or drop `limits`.",
    );
  }
  return { limiter: createLimiter({ callback: config.limits, ops: ops.usage }) };
};
