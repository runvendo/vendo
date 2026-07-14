import type { AuditEvent } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";

// CHARACTERIZATION ONLY: 02-store §2 now contracts append-only audit routing,
// but enforcement is explicitly deferred to Wave 3. This test documents the
// current mutable door and must be flipped to rejection assertions in Wave 3.
const auditEvent = (detail: string): AuditEvent => ({
  id: "aud_wave3_flip",
  at: "2026-07-14T00:00:00.000Z",
  kind: "tool-call",
  principal: { kind: "user", subject: "user_audit" },
  venue: "chat",
  presence: "present",
  detail: { value: detail },
});

for (const backend of backends()) {
  describe(`${backend.name} 02-store §2 audit append-only Wave 3 flip`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("currently permits same-id replacement and deletion through the routed door", async () => {
      const audit = made.store.records("vendo_audit");
      await audit.put({ id: "aud_wave3_flip", data: auditEvent("original") });
      await audit.put({ id: "aud_wave3_flip", data: auditEvent("replaced") });
      expect((await audit.get("aud_wave3_flip"))?.data).toEqual(auditEvent("replaced"));

      await audit.delete("aud_wave3_flip");
      expect(await audit.get("aud_wave3_flip")).toBeNull();
    });
  });
}
