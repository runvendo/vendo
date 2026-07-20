import {
  type AppDocument,
  type ApprovalId,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

/** The name half of core's 01 §8 `fn:<name>` grammar. */
export const FN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** 06-apps §4.1 — internal execution surface shared by open() and call(). */
export interface AppCaller {
  call(app: AppDocument, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  callFn(app: AppDocument, name: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  callQuery(app: AppDocument, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
}

/**
 * W0 — hooks the runtime attaches to capture the exact parked call. When a
 * mutating in-app ACTION (call(), not a read query) parks on an approval, the
 * runtime records the byte-exact call + context so it can re-dispatch it when
 * the owner approves (see parked-action.ts). Only actions resume; a parked
 * read query surfaces as a render error, not a stalled effect.
 */
export interface AppCallerHooks {
  onParkedAction(
    app: AppDocument,
    call: ToolCall,
    ctx: RunContext,
    approvalId: ApprovalId,
  ): Promise<void>;
}

// execution-v2 — the v1 MachineSessions fn: path is deleted. fn: refs on a
// machine-bearing app resolve over the v2 box door (fn.ts decorates this
// caller in createApps); what remains HERE is the fallthrough for an app with
// no machine, which settles as a CONTAINED error outcome — a stale binding
// must not take down open() or an automation run.
export const fnOutcome = (name: string): ToolOutcome => ({
  status: "error",
  error: FN_NAME_PATTERN.test(name)
    ? { code: "validation", message: `fn:${name} requires a machine; the app has not graduated` }
    : { code: "validation", message: `invalid fn reference: fn:${name}` },
});

/** 06-apps §4.1 — resolve fn: references and guard-bound host tools. */
export const createAppCaller = (tools: ToolRegistry, hooks?: AppCallerHooks): AppCaller => {
  // Returns the outcome AND the exact call/ctx it ran under, so the action path
  // can hand a byte-exact parked call to the approve→resume seam.
  const hostTool = async (
    app: AppDocument,
    ref: string,
    args: Json,
    ctx: RunContext,
  ): Promise<{ call: ToolCall; appCtx: RunContext; outcome: ToolOutcome }> => {
    const call: ToolCall = { id: `call_${globalThis.crypto.randomUUID()}`, tool: ref, args };
    const appCtx: RunContext = { ...ctx, venue: "app", appId: app.id };
    return { call, appCtx, outcome: await tools.execute(call, appCtx) };
  };

  return {
    async call(app, ref, args, ctx) {
      if (ref.startsWith("fn:")) return fnOutcome(ref.slice(3));
      const { call, appCtx, outcome } = await hostTool(app, ref, args, ctx);
      // An action the guard sent to approval is remembered so its effect can
      // land the moment the owner approves — the bug was that nobody did this.
      if (outcome.status === "pending-approval" && hooks !== undefined) {
        await hooks.onParkedAction(app, call, appCtx, outcome.approvalId);
      }
      return outcome;
    },
    async callFn(app, name) {
      return fnOutcome(name);
    },
    async callQuery(app, ref, args, ctx) {
      if (ref.startsWith("fn:")) return fnOutcome(ref.slice(3));
      return (await hostTool(app, ref, args, ctx)).outcome;
    },
  };
};
