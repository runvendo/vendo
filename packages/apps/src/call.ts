import {
  type AppDocument,
  type ApprovalId,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
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

// ---------------------------------------------------------------------------
// Re-gate 2026-07-26 I5-C — the deterministic amount-unit guard. An island
// fired host_transferMoney {amount: 25} ($0.25) for a typed $25: the island
// seam had no unit check, and the parked approval invited a mis-approval.
// What IS deterministic: a CENTS-classified input field (the field name ends
// in "cents", or the tool's own input schema describes it as cents / minor
// units) can never legally take a fractional number — a fractional value in
// that slot is a dollar amount by construction (cents are integers), so the
// call is rejected with a teaching error BEFORE the guard parks it. The
// integer case (25 meaning $25) is NOT decidable at this seam (25 is valid
// cents) — that class is covered by the unit-annotated tool sketches and the
// island contract's conversion rule in the generation prompts.
// ---------------------------------------------------------------------------

const CENTS_FIELD_NAME = /cents$/i;
const CENTS_DESCRIPTION = /\bcents\b|\bminor units?\b/i;
const DOLLARS_DESCRIPTION = /\bdollars\b/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const schemaProperties = (schema: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  return schema.properties;
};

/** The teaching error for a unit mismatch this seam can PROVE, or undefined.
 *  Walks the args against the tool's input schema (nested objects included). */
export const amountUnitIssue = (
  descriptor: ToolDescriptor,
  args: Json,
): string | undefined => {
  if (descriptor.risk === "read") return undefined;
  const walk = (value: unknown, properties: Record<string, unknown> | undefined): string | undefined => {
    if (!isRecord(value)) return undefined;
    for (const [field, fieldValue] of Object.entries(value)) {
      const propSchema = properties?.[field];
      if (isRecord(fieldValue)) {
        const nested = walk(fieldValue, schemaProperties(propSchema));
        if (nested !== undefined) return nested;
        continue;
      }
      if (typeof fieldValue !== "number" || Number.isInteger(fieldValue)) continue;
      const description = isRecord(propSchema) && typeof propSchema.description === "string"
        ? propSchema.description
        : "";
      // Contradictory metadata (a *cents field described as dollars) proves
      // nothing — skip, exactly as the prompt sketch declines to annotate it
      // (sections.ts unitAnnotation).
      if (DOLLARS_DESCRIPTION.test(description)) continue;
      if (CENTS_FIELD_NAME.test(field) || CENTS_DESCRIPTION.test(description)) {
        return `arg "${field}" on ${descriptor.name} takes integer cents (minor units), but ${fieldValue} is fractional — that is a dollar amount. Convert dollars to cents by multiplying by 100 (e.g. $25 → 2500) and send a whole number.`;
      }
    }
    return undefined;
  };
  return walk(args, schemaProperties(descriptor.inputSchema));
};

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
    // The deterministic unit guard (above) runs before the guard-bound
    // execute, so a provably-wrong-unit mutation never parks an approval the
    // user could mistakenly approve. Descriptor lookup failures skip the
    // check — an unknown tool still gets the registry's own not-found.
    const descriptor = (await tools.descriptors().catch(() => []))
      .find((candidate) => candidate.name === ref);
    if (descriptor !== undefined) {
      const issue = amountUnitIssue(descriptor, args);
      if (issue !== undefined) {
        return { call, appCtx, outcome: { status: "error", error: { code: "validation", message: issue } } };
      }
    }
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
