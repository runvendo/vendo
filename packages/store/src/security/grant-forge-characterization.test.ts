import type { PermissionGrant } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";

// ============================================================================
// CHARACTERIZATION TEST — NOT a proof of authorization safety.
//
// store.records("vendo_grants").put(...) writes a PermissionGrant VERBATIM. The
// reserved-collection writer validates the grant's SHAPE, then trusts its caller
// completely: whoever holds a StoreAdapter handle can mint any grant they like.
//
// This is SAFE ONLY because of a STRUCTURAL invariant enforced ONE LAYER UP (in
// @vendoai/apps): app / sandbox code NEVER receives a StoreAdapter handle. App
// code reaches the host solely through the guard-bound tool proxy, which is the
// component that actually decides authorization. The store is a trusted backend
// behind that boundary — it is not, and is not meant to be, an authorization
// gate. This test documents that trust boundary as an intentional invariant so a
// future refactor that leaks a store handle into a sandbox trips a red flag here.
// ============================================================================

const forgedGrant = (): PermissionGrant => ({
  id: "grt_forged_admin",
  subject: "user_attacker",
  tool: "host_wire_transfer",
  descriptorHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  scope: { kind: "tool" },
  duration: "standing",
  source: "chat",
  grantedAt: "2026-07-12T00:00:00.000Z",
});

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("writes a grant payload verbatim and reads it back (writer trusts its caller)", async () => {
      const grants = made.store.records("vendo_grants");
      const grant = forgedGrant();

      const written = await grants.put({ id: grant.id, data: grant });
      expect(written.id).toBe(grant.id);
      expect(written.data).toEqual(grant);

      // Reads back through the reserved-collection store, unchanged. There is NO
      // authorization check here by design — see the file header. Safety comes
      // from app code never holding this handle, not from this table refusing it.
      const readBack = await grants.get(grant.id);
      expect(readBack?.data).toEqual(grant);
    });
  });
}
