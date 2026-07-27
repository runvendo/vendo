import { canonicalJson, type AuditEvent, type RunContext, type ToolCall, type ToolOutcome, type ToolRegistry } from "@vendoai/core";

/** Discovery-discipline 2026-07-25 (criterion 11): the connect check runs
 * BEFORE any guard decision. Without it, a call to an unconnected brokered
 * tool asks first (minting an ApprovalRequest the user must answer) and only
 * then learns from the broker that the service was never connected — approval
 * spam for calls that could never run. The gate wraps the guard-bound
 * registry from the OUTSIDE, so an unconnected call returns the existing
 * connect-required flow with no approval minted and no broker round-trip;
 * guard.bind and every guard shape stay untouched. */
export interface ConnectGateOptions {
  /** Resolve the brokered-connector toolkit a tool belongs to; undefined =
   * not a per-user-connection tool (host tools, MCP, compounds) — ungated. */
  toolkitOf(tool: string): Promise<{ connector: string; toolkit: string } | undefined>;
  /** Whether the calling subject has an active connection for the toolkit.
   * `undefined` = the lookup is unavailable — the gate FAILS OPEN and the
   * existing broker-side connect-required outcome still catches the call. */
  isConnected(toolkit: string, ctx: RunContext): Promise<boolean | undefined>;
  /** Audit sink (the umbrella wires guard.report). A gated call never reaches
   * guard.bind's tool-call audit, so the gate reports its own — same event
   * shape, same connectorAccount enrichment the broker execution would have
   * carried. Best-effort: a failed report never fails the call. */
  report?(event: AuditEvent): Promise<void>;
}

export interface ConnectGate {
  /** The connect-required outcome for an unconnected brokered tool call;
   * undefined when the call may proceed (connected, ungated, or unknown). */
  check(call: ToolCall, ctx: RunContext): Promise<ToolOutcome | undefined>;
  /** Wrap a registry so execute() short-circuits with check()'s outcome. */
  bind(tools: ToolRegistry): ToolRegistry;
}

export function createConnectGate(options: ConnectGateOptions): ConnectGate {
  const check = async (call: ToolCall, ctx: RunContext): Promise<ToolOutcome | undefined> => {
    let target: { connector: string; toolkit: string } | undefined;
    try {
      target = await options.toolkitOf(call.tool);
    } catch {
      return undefined; // a broken lookup must never take the call down
    }
    if (target === undefined) return undefined;
    let connected: boolean | undefined;
    try {
      connected = await options.isConnected(target.toolkit, ctx);
    } catch {
      connected = undefined;
    }
    if (connected !== false) return undefined;
    return {
      status: "connect-required",
      connect: {
        connector: target.connector,
        toolkit: target.toolkit,
        // The same message shape the broker-side outcome carries, so the
        // inline connect card renders identically (04-actions §3).
        message: `Connect your ${target.toolkit} account to run ${call.tool}.`,
      },
    };
  };

  /** guard.bind's inputPreview shape, so gated and executed calls read the
   * same in the activity feed. */
  const preview = (call: ToolCall): string => {
    const text = `${call.tool} ${canonicalJson(call.args)}`;
    return text.length > 500 ? `${text.slice(0, 499)}…` : text;
  };

  const reportGated = async (call: ToolCall, ctx: RunContext, outcome: ToolOutcome): Promise<void> => {
    if (options.report === undefined || outcome.status !== "connect-required") return;
    try {
      await options.report({
        // Empty id/at ride guard.report's normalization (it mints aud_ ids).
        id: "",
        at: "",
        kind: "tool-call",
        principal: ctx.principal,
        venue: ctx.venue,
        presence: ctx.presence,
        ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
        ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
        tool: call.tool,
        inputPreview: preview(call),
        outcome: outcome.status,
        detail: {
          connectorAccount: {
            connector: outcome.connect.connector,
            toolkit: outcome.connect.toolkit,
            entityId: ctx.principal.subject,
          },
        },
      });
    } catch {
      // The audit trail is best-effort here; the connect card must render.
    }
  };

  return {
    check,
    bind: (tools) => ({
      descriptors: () => tools.descriptors(),
      execute: async (call, ctx) => {
        const gated = await check(call, ctx);
        if (gated === undefined) return tools.execute(call, ctx);
        await reportGated(call, ctx, gated);
        return gated;
      },
    }),
  };
}
