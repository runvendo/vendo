import {
  type AppDocument,
  type Json,
  type RunContext,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

const FN_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** 06-apps §4.1 — internal execution surface shared by open() and call(). */
export interface AppCaller {
  call(app: AppDocument, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  callFn(app: AppDocument, name: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  callQuery(
    app: AppDocument,
    ref: string,
    args: Json,
    ctx: RunContext,
  ): Promise<{ outcome: ToolOutcome; uiEnvelope: boolean }>;
}

// execution-v2 — the v1 MachineSessions fn: path is deleted. fn: refs on a
// machine-bearing app resolve over the v2 box door (fn.ts decorates this
// caller in createApps); what remains HERE is the fallthrough for an app with
// no machine, which settles as a CONTAINED error outcome — a stale binding
// must not take down open() or an automation run.
const fnOutcome = (name: string): ToolOutcome => ({
  status: "error",
  error: FN_PATTERN.test(name)
    ? { code: "validation", message: `fn:${name} requires a machine; the app has not graduated` }
    : { code: "validation", message: `invalid fn reference: fn:${name}` },
});

/** 06-apps §4.1 — resolve fn: references and guard-bound host tools. */
export const createAppCaller = (tools: ToolRegistry): AppCaller => {
  const hostTool = (app: AppDocument, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome> =>
    tools.execute(
      { id: `call_${globalThis.crypto.randomUUID()}`, tool: ref, args },
      { ...ctx, venue: "app", appId: app.id },
    );

  return {
    async call(app, ref, args, ctx) {
      if (ref.startsWith("fn:")) return fnOutcome(ref.slice(3));
      return hostTool(app, ref, args, ctx);
    },
    async callFn(app, name) {
      return fnOutcome(name);
    },
    async callQuery(app, ref, args, ctx) {
      if (ref.startsWith("fn:")) return { outcome: fnOutcome(ref.slice(3)), uiEnvelope: false };
      return { outcome: await hostTool(app, ref, args, ctx), uiEnvelope: false };
    },
  };
};
