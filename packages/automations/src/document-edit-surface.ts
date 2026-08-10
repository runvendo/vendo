/**
 * Build contract §9.9 — the apps runtime's `onDocumentEdit` hook, from this
 * side: an edit by anyone other than the sponsor invalidates sponsorship; the
 * sponsor's own edit re-binds the intent instead.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import type { AppDocument, Trigger } from "@vendoai/core";
import type { EngineBase } from "./engine-context.js";
import type { AutomationsEngine } from "./index.js";
import type { SponsorshipGateAccess } from "./sponsorship-gate.js";
import { currentIntentHash, triggersOf, writeSponsorship } from "./sponsorship.js";

export type DocumentEditSurfaceDeps = { base: EngineBase; sponsorship: SponsorshipGateAccess };

export const createDocumentEditSurface = (
  { base: { iso }, sponsorship }: DocumentEditSurfaceDeps,
): Pick<AutomationsEngine, "onDocumentEdit"> => {
  const onTriggerEdit = async (next: AppDocument, trigger: Trigger, editor: string): Promise<void> => {
    // Through the migrating door: an edit is the other way a pre-list row can be
    // reached before its automation ever fires again, and a row nobody can see
    // is a row a third party's edit cannot invalidate.
    const state = await sponsorship.sponsorshipState(next, trigger.id);
    if (state.kind !== "row" || state.row.status !== "active") return;
    const row = state.row;
    if (editor !== row.sponsor) {
      await writeSponsorship(sponsorship.sponsorships(), {
        ...row,
        status: "invalidated",
        reason: "edit",
        invalidatedAt: iso(),
      });
      return;
    }
    // The sponsor editing their OWN automation does not invalidate sponsorship
    // (§13) — but the intent it was minted over just changed, so re-bind it
    // here. Without this the fire-time hash check would stop the automation for
    // an edit its own sponsor made, which is the same stop for the opposite
    // reason. Their GRANT set may still be invalidated by the change; that is
    // the automations-pack session's half, and it fails at the guard with a
    // card rather than here.
    const hash = currentIntentHash(next, trigger);
    if (hash !== row.intentHash) {
      await writeSponsorship(sponsorship.sponsorships(), { ...row, intentHash: hash });
    }
  };

  /** §9.9 — invalidation on a third party's edit. Called by the apps runtime
   *  after a successful persist (the `onDocumentEdit` config hook), so the
   *  choke point stays where the write already is. */
  const onDocumentEdit: AutomationsEngine["onDocumentEdit"] = async (_previous, next, editor) => {
    // Per trigger, because sponsorship is: editing one trigger must not stop the
    // app's others, and re-binding one sponsor's intent must not touch another's.
    for (const trigger of triggersOf(next)) await onTriggerEdit(next, trigger, editor);
  };

  return { onDocumentEdit };
};
