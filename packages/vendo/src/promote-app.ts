import { safeErrorMessage, type AppId } from "@vendoai/core";
import type { AppMount } from "@vendoai/store";

/**
 * Build contract §9.5 — promote's two halves, in the order that makes it
 * all-or-nothing, and the rollback rule that keeps it honest under concurrency.
 *
 * The store seam (01-core §12) has no transaction, so the halves run in the one
 * order where a failure is recoverable: the DOCUMENTS move first (that is the
 * step that can collide, and it refuses before touching a row) and the ROW flips
 * last. A rollback then undoes only what THIS call did — see below; getting that
 * wrong is how two simultaneous promotes left the owner with a half-moved app
 * she could no longer see.
 *
 * Lives in its own module because the rule is the interesting part: composed
 * with the real stores in `createVendo`, and with fakes in promote-app.test.ts,
 * where the failure interleavings are deterministic.
 */
export interface PromoteHalves {
  /** The `vendo_apps` row: read its subject, and flip it (guarded on `from`). */
  rows: {
    get(appId: AppId): Promise<{ subject: string } | null>;
    promote(appId: AppId, from: string, orgId: string): Promise<void>;
  };
  /** The app's workspace documents, moved between mounts (owner + path). */
  workspace: { moveApp(appId: string, from: AppMount, to: AppMount): Promise<number> };
}

export function createPromoteApp(
  halves: PromoteHalves,
): (appId: AppId, from: string, orgId: string) => Promise<void> {
  return async (appId, from, orgId) => {
    const personal = { kind: "user", subject: from } as const;
    const team = { kind: "org", org: orgId } as const;
    await halves.workspace.moveApp(appId, personal, team);
    try {
      await halves.rows.promote(appId, from, orgId);
    } catch (failure) {
      // Reverse the move only while the row still names `from` — i.e. only when
      // THIS call is the only thing that changed anything. A lost race means a
      // concurrent promote already flipped the row, so the documents under
      // /orgs are ITS documents: moving them back would leave the winner's app
      // half-moved and invisible to its own owner.
      if ((await halves.rows.get(appId))?.subject !== from) throw failure;
      try {
        await halves.workspace.moveApp(appId, team, personal);
      } catch (rollbackFailure) {
        // The caller hears the ORIGINAL cause: the rollback's own error would
        // send them to fix the wrong thing. The state that needs a human is
        // loud here instead, with both reasons and the exact paths.
        console.error(
          `[vendo] promote of ${appId} failed AND its documents could not be moved back: `
          + `they are under /orgs/${orgId}/apps/${appId}/ while the row still says ${from}. `
          + `Cause: ${safeErrorMessage(failure)} — rollback: ${safeErrorMessage(rollbackFailure)}`,
        );
      }
      throw failure;
    }
  };
}
