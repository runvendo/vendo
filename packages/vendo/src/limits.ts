/**
 * Per-user limits: Vendo counts, the host decides.
 *
 * The host's `limits` callback is asked once before each metered action and its
 * verdict is honored. Everything else about a limit lives HERE — reading the
 * meter, invoking the policy, recording what an allow spent, and the fail mode —
 * so a choke point is one `gate` call and can never grow its own half of the
 * rule.
 *
 * The fail mode is the load-bearing decision: a policy that throws DENIES. A
 * limits system that fails open stops limiting silently, so the host keeps
 * believing they have a cap while every user is unlimited — strictly worse than
 * a turn that was refused and said so.
 */
import {
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  isVendoError,
  VendoError,
  log,
  type LimitAction,
  type LimitWindow,
  type LimitUser,
  type LimitsCallback,
  type RunContext,
  type StoreOps,
  type ToolRegistry,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";

/** The decision a choke point acts on — `LimitDecision`'s two forms collapsed to
    one, so no caller re-derives the boolean/object grammar. */
export type LimitVerdict = { allow: true } | { allow: false; message?: string; retryable?: true };

export interface Limiter {
  gate(action: LimitAction, ctx: RunContext): Promise<LimitVerdict>;
}

/** The sentence for a limit that could not be CHECKED — told to the agent and
    to the person alike, and the one thing it must not sound like is a cap. */
const SERVICE_BUSY = "Vendo Cloud is busy right now, so this limit could not be checked — this is temporary, not a cap.";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** `UsageCountQuery.since` is required, so "all time" is the epoch. */
const ALL_TIME = new Date(0);

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
      // Pre-bound to THIS subject: a policy never names one, so it can never
      // read another person's usage by accident.
      const count = (counted: LimitAction, window?: LimitWindow): Promise<number> => {
        const lookback = (window?.days ?? 0) * DAY + (window?.hours ?? 0) * HOUR
          + (window?.minutes ?? 0) * MINUTE;
        const since = lookback > 0 ? new Date(Date.now() - lookback) : window?.since ?? ALL_TIME;
        if (window?.pool === undefined) return ops.count({ action: counted, since, subject });
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
        return ops.count({ action: counted, since, poolKey });
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
        // The count is a live store read, so the policy can fail because Vendo
        // Cloud is rate-limiting or down (`unavailable`) rather than because
        // this user spent anything. Still a DENY — but never dressed as a cap
        // they reached, because nothing was counted.
        return isVendoError(error) && error.code === "unavailable"
          ? { allow: false, message: SERVICE_BUSY, retryable: true }
          : { allow: false };
      }
      if (decision !== true) return decision === false ? { allow: false } : decision;
      // Awaited, not fire-and-forget: the next action's count has to see this
      // one, and a dropped write is a limit that never arrives.
      await ops.record({ subject, action, at: new Date(), poolKeys: Object.values(pools) });
      return { allow: true };
    },
  };
}

/** What the AGENT is told when a build was refused — FACTS, like every other
 *  refusal on this registry (`ask-user.ts`, apps' `FORBIDDEN_FACTS`): what did
 *  not happen, the host's own sentence when the policy wrote one, and whether
 *  the call is worth repeating — a cap never is, a busy meter is. The person is
 *  told by the card beside it. */
const generationDenied = (verdict: Extract<LimitVerdict, { allow: false }>): string =>
  verdict.retryable === true
    ? `The app was not built: ${SERVICE_BUSY} Nothing was counted against this user, so the same call is worth making again.`
    : "The app was not built: this user has reached a limit the host's own policy sets."
      + `${verdict.message === undefined ? "" : ` The host says: ${verdict.message}`}`
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
      part: {
        type: "data-vendo-limit",
        ...(verdict.message === undefined ? {} : { message: verdict.message }),
        ...(verdict.retryable === undefined ? {} : { retryable: verdict.retryable }),
      },
    });
    return { status: "blocked", reason: generationDenied(verdict) };
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
