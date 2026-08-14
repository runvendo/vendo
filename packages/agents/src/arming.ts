/**
 * ARMING — the present-time ceremony that turns "let this run while I am away"
 * into standing authority. The asks are raised through the guard's own away
 * check, so the question the person answers is exactly the question that firing
 * would have raised — and the grant a yes mints is the one that firing looks up.
 *
 * KNOWN LIMIT — the raised asks live in THIS process's memory until they are
 * answered. A restart between raising an ask and deciding it loses the mint, and
 * the person arms again. Persisting them would mean a reserved collection of
 * this package's own, which arming does not have.
 */
import {
  DEFAULT_TRIGGER_ID,
  descriptorHash,
  presenceOnlyCall,
  withheldFromUnattended,
  type AppId,
  type ApprovalId,
  type ApprovalRequest,
  type RunContext,
  type RunId,
  type ToolRegistry,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import type { VendoStore } from "@vendoai/store";
import { randomUUID } from "node:crypto";

export interface ArmRequest {
  /** The automation this authority is for. */
  appId: string;
  /** WHICH trigger of it — each is consented to on its own. Unset → `main`. */
  triggerId?: string;
  /** Unset ⇒ every bound tool an unattended run may still reach. */
  tools?: readonly string[];
}

export interface ArmResult {
  /** One ask per wanted tool, for a person to answer on the permission wire. */
  pending: ApprovalId[];
  /** Tools no unattended run may reach whatever anyone allows — never asked. */
  held: readonly string[];
}

export interface ArmDeps {
  guard: VendoGuard;
  store: VendoStore;
  /** The agent's guard-bound registry — an unattended run's whole tool surface. */
  tools: ToolRegistry;
}

/**
 * The row a consent moment leaves for the ONE mint path, keyed by the approval
 * it is the ask for (core's engine allowlist, `engine-collections.ts`).
 *
 * Whoever else subscribes to `onApprovalDecision` on this guard, the automations
 * engine's subscriber reads THIS first, and only an approval with no such row
 * falls through to its app-wide fallback — the branch that derives the trigger
 * from the RUN ROW the approval was raised inside. A present-time ceremony has
 * no run, so that fallback reads `undefined` and mints an APP-WIDE standing
 * grant: the trigger the person armed holds nothing, and `main` — never shown to
 * anyone — holds unattended authority. The row is what makes the ask
 * unclaimable by that fallback, whichever subscriber the host registered first.
 */
const CAPTURES = "automations:captures";

/** The ceremony, with its own memory of what it has asked. */
export function createArm(deps: ArmDeps): (subject: string, request: ArmRequest) => Promise<ArmResult> {
  /** The asks this process raised, by the approval they are waiting on. */
  const raised = new Map<ApprovalId, { request: ApprovalRequest; triggerId: string }>();

  deps.guard.onApprovalDecision(async (id, approved) => {
    const armed = raised.get(id);
    if (armed === undefined) return;
    raised.delete(id);
    // The ask is answered, so its marker is spent whichever subscriber acted on
    // it — a row outliving its approval would keep counting as an open question.
    await deps.store.records(CAPTURES).delete(id);
    if (!approved) return;
    // Spend BEFORE minting: a yes the person took back at this instant must arm
    // nothing, and the take-back and the mint contend for the approval's one
    // one-time transition, so only one of them can ever win it. Both seams are
    // optional on the interface and both fail CLOSED — a guard that cannot spend
    // cannot linearize a take-back against a mint, and one that cannot mint has
    // nowhere to put the grant.
    if (await deps.guard.spendApproval?.(id, armed.request.ctx.principal) !== "spent") return;
    await deps.guard.mintGrant?.({
      request: armed.request,
      remember: { duration: "standing" },
      source: "automation",
      triggerId: armed.triggerId,
    });
  });

  return async (subject, { appId, triggerId = DEFAULT_TRIGGER_ID, tools }) => {
    await deps.store.ensureSchema();
    // Listed PRESENT: §12's unattended projection hides the very tools this has
    // to report as held.
    const descriptors = await deps.tools.descriptors({ venue: "automation", presence: "present" });
    // Asked as the AWAY call it is about — same appId, same trigger — because
    // the ask is only worth answering if it is the firing's own ask.
    const ctx: RunContext = {
      principal: { kind: "user", subject },
      venue: "automation",
      presence: "away",
      sessionId: `arm_${randomUUID()}`,
      appId: appId as AppId,
      trigger: { runId: `run_${randomUUID()}` as RunId, kind: "host-event", id: triggerId },
    };
    // `previewCheck`, not `check`: nothing dispatches here, so the ceremony must
    // not spend a run's write budget or the subject's call-rate window. It parks
    // an ask exactly as `check` does.
    const ask = deps.guard.previewCheck?.bind(deps.guard) ?? deps.guard.check.bind(deps.guard);
    const pending: ApprovalId[] = [];
    const held: string[] = [];
    for (const descriptor of descriptors) {
      if (tools !== undefined && !tools.includes(descriptor.name)) continue;
      const call = { id: `call_${randomUUID()}`, tool: descriptor.name, args: {} };
      // THE LAW an away run runs under has two halves, and `bind().execute()`
      // enforces both: the withheld GRADES, and the placement tools it refuses
      // away BY NAME. A card for either is a card for a call that can never
      // happen, and a yes on it mints standing authority for nothing.
      if (withheldFromUnattended(descriptor) || presenceOnlyCall(call)) {
        held.push(descriptor.name);
        continue;
      }
      const decision = await ask(call, descriptor, ctx);
      // Anything else is already answered: a live grant runs, a standing no blocks.
      if (decision.action !== "ask") continue;
      // The grade §12 is applied to is the RESOLVED one (the guard re-grades a
      // call through `resolveRisk` before it rules on it), and the parked ask —
      // which carries the descriptor the guard itself decided on — is the only
      // place a ceremony can read it. A tool this deployment re-grades
      // destructive is held, and the card it just raised is withdrawn.
      if (withheldFromUnattended(decision.approval.descriptor)) {
        held.push(descriptor.name);
        await deps.guard.abandonApprovals?.([decision.approval.id], ctx);
        continue;
      }
      await deps.store.records(CAPTURES).put({
        id: decision.approval.id,
        data: {
          appId,
          triggerId,
          subject,
          tool: descriptor.name,
          descriptorHash: descriptorHash(decision.approval.descriptor),
        },
        refs: { subject, app_id: appId, trigger_id: triggerId },
      });
      raised.set(decision.approval.id, { request: decision.approval, triggerId });
      pending.push(decision.approval.id);
    }
    return { pending, held };
  };
}
