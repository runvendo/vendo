/**
 * Lane E — approving an app's declared egress. It rides the guard's existing
 * confirmEach-approval flow and commits from the `onApprovalDecision`
 * subscription below.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  isVendoError,
  VendoError,
  type AppId,
  type ApprovalId,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import { normalizeEgressDomain, unapprovedEgress } from "../escalation/egress-approval.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";

// Lane E — approving an app's declared egress is a HIGH-RISK approval reusing
// the guard's existing confirmEach-approval flow (approval card in-client, no
// new ceremony types): check() with this descriptor parks an approval, and the
// onApprovalDecision subscription below commits the parked domains onto the
// app document's egressApproved field only when the owner approves. This is the
// SAME onApprovalDecision seam automations use to resume a parked run — no
// parallel approval mechanism is introduced.
const EGRESS_TOOL = "vendo_egress_allow";
const egressDescriptor = (): ToolDescriptor => ({
  name: EGRESS_TOOL,
  description: "Allow this app's machine outbound network access to its declared egress domains (high-risk, owner-only).",
  inputSchema: {
    type: "object",
    properties: {
      appId: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
    },
    required: ["appId", "domains"],
  },
  risk: "destructive",
  confirmEach: true,
});
// Stable across the park/approve phases so the real guard's approved-replay
// match (subject + call id + args + descriptor + venue/presence/app) lines up.
const egressCall = (appId: AppId, domains: string[]): ToolCall => ({
  id: `call_egress_${appId}_${domains.join("_")}`,
  tool: EGRESS_TOOL,
  args: { appId, domains },
});

const createEgressGrants = (
  deps: Pick<AppsRuntimeContext,
    "config" | "egressApprovals" | "holds" | "lifecycle" | "updateAppDocument" | "reportGuard">,
) => {
  const { config, egressApprovals, holds, lifecycle, updateAppDocument, reportGuard } = deps;
  const commitEgressApproval = async (
    appId: AppId,
    domains: string[],
    owner: string,
  ): Promise<void> => {
    const updated = await updateAppDocument(appId, (doc) => ({
      ...doc,
      egressApproved: [...new Set([
        ...(doc.egressApproved ?? []).map(normalizeEgressDomain),
        ...domains,
      ])],
    }));
    for (const domain of domains) await egressApprovals.remove(appId, domain);
    // A sleeping snapshot carries the pre-grant allowlist and the wake-time
    // policy override fixes that — but a LIVE machine still runs the old
    // network policy, so put it to sleep; its next wake applies the grant.
    await lifecycle.sleep(updated).catch(() => undefined);
    await reportGuard(owner, appId, { venue: "app", presence: "present" }, {
      operation: "egress-approved",
      domains,
    });
  };

  /**
   * Lane E — request approval for an app's declared-but-unapproved egress. On
   * "block" it throws; a pre-approved replay commits immediately; otherwise it
   * PARKS the approval card and returns its id and domains WITHOUT throwing, so
   * a caller (graduation) can surface a pending approval as an edit outcome
   * rather than a failure. This is the one seam that can ASK — it has the
   * acting principal; the lifecycle's ctx-less policy callback only refuses.
   */
  const requestEgressApproval = async (
    app: AppDocument,
    ctx: RunContext,
  ): Promise<{ status: "none" } | { status: "approved"; domains: string[] } | { status: "pending"; approvalId: ApprovalId; domains: string[] }> => {
    const unapproved = unapprovedEgress(app);
    if (unapproved.length === 0) return { status: "none" };
    const guardCtx: RunContext = { ...ctx, appId: app.id };
    const decision = await config.guard.check(egressCall(app.id, unapproved), egressDescriptor(), guardCtx);
    if (decision.action === "block") {
      throw new VendoError("blocked", decision.reason);
    }
    if (decision.action === "run") {
      // A pre-approved replay already cleared the high-risk gate — commit now.
      await commitEgressApproval(app.id, unapproved, ctx.principal.subject);
      return { status: "approved", domains: unapproved };
    }
    const requestedAt = new Date().toISOString();
    for (const domain of unapproved) {
      await egressApprovals.putPending({
        appId: app.id,
        domain,
        owner: ctx.principal.subject,
        approvalId: decision.approval.id,
        requestedAt,
      });
    }
    return { status: "pending", approvalId: decision.approval.id, domains: unapproved };
  };

  /**
   * Lane E — the ctx-carrying pre-flight run by provision/wake/box surfaces:
   * declared domains without a grant park the approval card and the operation
   * refuses loudly until the owner decides. Graduation uses the non-throwing
   * {@link requestEgressApproval} directly.
   */
  const ensureEgressApproved = async (app: AppDocument, ctx: RunContext): Promise<void> => {
    // An egress approval is self-subject like every approval, but its EFFECT is
    // not: the decision writes `egressApproved` onto the SHARED app document and
    // binds everyone who uses the app from then on. So the ask belongs to a
    // caller who can CHANGE the app — which is what this module has always said
    // it records (`EgressApprovalRequest.owner`: "the only principal who may
    // approve"). Two doors reach here at viewer level (§9.8's `serve` and
    // `machine.ping`), and they parked a card in the viewer's name. They now
    // refuse in the same words a ctx-less wake does, and wait for an editor.
    const undecided = unapprovedEgress(app);
    if (undecided.length > 0 && !(await holds(app.id, ctx, "editor"))) {
      throw new VendoError(
        "blocked",
        `machine egress is not approved for: ${undecided.join(", ")}`
        + " — only someone who can change this app can approve it",
        { unapprovedDomains: undecided },
      );
    }
    const outcome = await requestEgressApproval(app, ctx);
    if (outcome.status === "pending") {
      throw new VendoError(
        "blocked",
        `machine egress requires approval for: ${outcome.domains.join(", ")}`,
        { status: "pending-approval", approvalId: outcome.approvalId, unapprovedDomains: outcome.domains },
      );
    }
  };

  return { commitEgressApproval, requestEgressApproval, ensureEgressApproved };
};

const subscribeApprovalDecisions = (
  deps: Pick<AppsRuntimeContext, "config" | "egressApprovals" | "parkedActions" | "reportGuard">
    & Pick<ReturnType<typeof createEgressGrants>, "commitEgressApproval">,
): void => {
  const { config, egressApprovals, parkedActions, reportGuard } = deps;
  const { commitEgressApproval } = deps;
  const onApprovalDecision = async (id: ApprovalId, approved: boolean): Promise<void> => {
    // Lane E — parked egress domains riding this approval commit or clear as
    // one batch per app (a card's call pins a single appId, but group anyway).
    const parkedEgress = await egressApprovals.byApproval(id);
    if (parkedEgress.length > 0) {
      const byApp = new Map<AppId, { owner: string; domains: string[] }>();
      for (const request of parkedEgress) {
        const entry = byApp.get(request.appId) ?? { owner: request.owner, domains: [] };
        entry.domains.push(request.domain);
        byApp.set(request.appId, entry);
      }
      for (const [appId, entry] of byApp) {
        if (approved) {
          try {
            await commitEgressApproval(appId, entry.domains, entry.owner);
          } catch (error) {
            // The app vanished between park and decision (delete raced the
            // card): there is nothing to grant — clear the orphaned records.
            for (const domain of entry.domains) await egressApprovals.remove(appId, domain);
            if (!(isVendoError(error) && error.code === "not-found")) throw error;
          }
        } else {
          // Denial leaves the declaration unapproved (fail closed) and clears the card.
          for (const domain of entry.domains) await egressApprovals.remove(appId, domain);
          await reportGuard(entry.owner, appId, { venue: "app", presence: "present" }, {
            operation: "egress-denied",
            domains: entry.domains,
          });
        }
      }
    }

    // W0 — resume a parked in-app action. Approval makes the exact parked call
    // eligible for the guard's one-shot approved replay, so re-dispatching it
    // through the guard-bound registry runs it and lands the host effect. The
    // record clears either way (approve = ran; deny = fail closed, never runs).
    const parkedAction = await parkedActions.byApproval(id);
    if (parkedAction !== null) {
      try {
        // Contained: a failed resume must never roll back the approval (the
        // guard already swallows subscriber throws, but be explicit here so
        // the record is always cleared). The resume's ANSWER is persisted
        // beside the effect — the screen that pressed the button is not on this
        // call stack and learns what happened only by reading it back.
        if (approved) {
          const outcome = await config.tools.execute(parkedAction.call, parkedAction.ctx);
          await parkedActions.resolve(parkedAction, { state: "executed", outcome });
        } else {
          await parkedActions.resolve(parkedAction, { state: "declined" });
        }
      } finally {
        await parkedActions.remove(id);
      }
    }
  };
  config.guard.onApprovalDecision((id, approved) => onApprovalDecision(id, approved));
};

/** The egress approval slice of `createApps`' closure. */
export const createApprovalFlow = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "egressApprovals" | "parkedActions"
    | "holds" | "lifecycle" | "updateAppDocument" | "reportGuard">,
) => {
  const egressGrants = createEgressGrants(deps);
  subscribeApprovalDecisions({ ...deps, ...egressGrants });
  return {
    requestEgressApproval: egressGrants.requestEgressApproval,
    ensureEgressApproved: egressGrants.ensureEgressApproved,
  };
};
