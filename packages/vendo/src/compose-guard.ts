/**
 * 05-guard — THE choke point, and the two things composition adds to it: the
 * plumbing a spec-shaped `guard()` cannot supply (store, risk resolver, cloud
 * policy fallback, org layer), and the one-shot warning a present-mode host
 * tool call raises when its credentials cannot be forwarded.
 */
import { RESERVED_SUBJECT_PREFIX, type RunContext, type ToolDescriptor } from "@vendoai/core";
import {
  createGuard,
  isGuardInstance,
  type GuardRules,
  type PolicyConfig,
  type RiskResolver,
  type VendoGuard,
} from "@vendoai/guard";
import type { VendoComposition } from "./compose-context.js";
import { selectConfigSurface } from "./config-surface.js";
import { orgPolicyPath, orgPolicyResolver, workspacePolicySource } from "./org-policy.js";

/** ADAPTER RULE, guard seam: a built VendoGuard is this deployment's choke
 *  point verbatim; a spec is completed here. ONE constructor either way. */
export const composeGuard = (composition: VendoComposition): Pick<VendoComposition,
  "guard" | "resolveRisk" | "warnPresentCredentialsNotForwarded"> => {
  const { config, store, configCloud, readSurfaceFile } = composition;
  // Task 15a: profile.policy is the parsed policy.json document held in
  // memory — the hosted try venue's demo policy, where the local venue
  // writes the file instead (cli/try/extract.ts). Precedence keeps the
  // sibling pieces' discipline: the longer-standing explicit `policy` knob
  // wins outright; otherwise the piece feeds the guard as inline rules +
  // directions (defaulted like an absent file key), which replace the
  // file/cloud legs entirely (inline wins with no merge — 00-overview
  // decision 19); an unset piece leaves the guard's own file/cloud reads
  // unchanged.
  //
  // The `guard:` slot's spec arm is where the host's rules live now; an
  // INSTANCE arm brings its own and is taken verbatim below, so there are no
  // rules to complete.
  const guardRules: GuardRules = isGuardInstance(config.guard) ? {} : config.guard ?? {};
  const configPolicy: PolicyConfig | undefined = guardRules.policy ?? (
    config.profile?.policy === undefined ? undefined : {
      rules: config.profile.policy.rules ?? [],
      directions: config.profile.policy.directions ?? [],
    }
  );
  // The resolver is installed immediately after createApps below. Keeping the
  // hook in guard means chat/SSE and the MCP door reach the same decision.
  //
  // Two resolvers, chained, app first: an app's own tool grade is a decision a
  // person made in this deployment, so it outranks a broker's catalog tag —
  // and the two can never collide anyway, since only `use_service_tool`
  // reaches the second leg.
  //
  // Named rather than inlined because the automations engine takes the SAME
  // function: arm-time capture has to grade a declared connector call exactly
  // as the away call will be graded, or the grant it mints is hashed against a
  // label the guard never sees and is invalidated on first use.
  const resolveRisk: RiskResolver = async (call, _descriptor, ctx) =>
    (await composition.resolveAppToolRisk?.(call, ctx)) ?? await composition.serviceToolRisk(call);
  // ADAPTER RULE, guard seam: a built VendoGuard is this deployment's choke
  // point verbatim; rules are completed here with the plumbing only a
  // composition can supply — the store, the app/service risk resolver, the
  // cloud policy fallback, the org layer. ONE constructor either way.
  const guard = isGuardInstance(config.guard) ? config.guard : createGuard({
    store,
    resolveRisk,
    ...(guardRules.approvals === undefined ? {} : { approvals: guardRules.approvals }),
    ...(guardRules.breakers === undefined ? {} : { breakers: guardRules.breakers }),
    ...(configPolicy === undefined ? {} : { policy: configPolicy }),
    // cse lane 3 — a cloud policy.json body, consulted by the resolver STRICTLY
    // AFTER the local file and only within its existing opt-in path (decision
    // 3: no change for hosts that don't configure policy). Returns the cloud
    // value only when the surface is cloud-owned; a local file is handled by
    // the guard's own file read.
    ...(configCloud === undefined ? {} : {
      policyCloudFallback: (): string | undefined => {
        const resolved = selectConfigSurface("policy.json", { readFile: readSurfaceFile, cloud: configCloud });
        return resolved.owner === "cloud" ? resolved.value : undefined;
      },
    }),
    ...(guardRules.judge === undefined ? {} : { judge: guardRules.judge }),
    // Build contract §9.10 — the org-admin layer, composed at the seam like
    // every other adapter choice: the guard evaluates rules, this reads them.
    // Callers with no asserted memberships (every unkeyed deployment, and any
    // request whose host asserted none) resolve to no rules at all.
    //
    // A per-ORG failure (unreadable or malformed policy.json) skips that org's
    // rules and lands on the audit trail, so the admin whose file is broken can
    // see their policy is not in force. Reported through the guard that is being
    // constructed here — the callback only ever runs inside a later check, which
    // is the same late-binding `resolveRisk` above uses.
    orgPolicy: orgPolicyResolver(workspacePolicySource(store), async (org, reason) => {
      console.warn(
        `[vendo] org policy for "${org}" was not applied: ${reason} `
        + `(its rules live at ${orgPolicyPath(org)}) — until then this org's rules are not in force.`,
      );
      await guard.report({
        id: `aud_${globalThis.crypto.randomUUID()}`,
        at: new Date().toISOString(),
        kind: "policy-decision",
        // A broken org file is nobody's personal event, so it is audited under
        // the runtime's own reserved namespace (`vendo:`, block-actions §C)
        // rather than pinned to whichever member happened to trigger the read.
        principal: { kind: "user", subject: `${RESERVED_SUBJECT_PREFIX}org-policy:${org}` },
        venue: "chat",
        presence: "away",
        detail: { reason: "org-policy-unavailable", org, message: reason },
      });
    }),
  });
  return {
    guard,
    resolveRisk,
    warnPresentCredentialsNotForwarded: presentCredentialsWarning(guard),
  };
};

/** 04 §4 — the once-per-process warning a present-mode host tool call raises
 *  when the wire has no trusted origin to forward the caller's credentials to. */
const presentCredentialsWarning = (
  guard: VendoGuard,
): VendoComposition["warnPresentCredentialsNotForwarded"] => {
  let presentCredentialsWarningEmitted = false;
  const warnPresentCredentialsNotForwarded = async (event: {
    ctx: RunContext;
    tool: ToolDescriptor;
    reason: "untrusted-host-origin" | "cross-origin-binding";
  }): Promise<void> => {
    if (presentCredentialsWarningEmitted) return;
    presentCredentialsWarningEmitted = true;
    const action = event.reason === "untrusted-host-origin"
      ? "Set VENDO_BASE_URL to the host origin and restart the server."
      : "Keep present host authentication same-origin, or use actAs/connector authentication.";
    try {
      await guard.report({
        id: `aud_${globalThis.crypto.randomUUID()}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        principal: event.ctx.principal,
        venue: event.ctx.venue,
        presence: event.ctx.presence,
        ...(event.ctx.appId === undefined ? {} : { appId: event.ctx.appId }),
        ...(event.ctx.trigger === undefined ? {} : { trigger: event.ctx.trigger }),
        tool: event.tool.name,
        detail: {
          warning: {
            code: "present-credentials-not-forwarded",
            reason: event.reason,
            action,
          },
        },
      });
    } catch (error) {
      // Let a later call retry the warning if the audit sink was temporarily down.
      presentCredentialsWarningEmitted = false;
      throw error;
    }
  };
  return warnPresentCredentialsNotForwarded;
};
