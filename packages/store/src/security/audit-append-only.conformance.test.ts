import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { eraseStore } from "../erase.js";
import { auditStore } from "../index.js";
import { auditFixture } from "../fixtures.test-util.js";

// 02-store §2: "append-only audit log (core §7): routing rejects `put` for an
// existing id and refuses `delete` ... erasure is only through the store erase
// API (§5)." This suite is the Wave 3 flip of the former mutability
// characterization test (audit-mutation-characterization.test.ts).

const anon: Principal = { kind: "user", subject: "anon_audit", ephemeral: true };

for (const backend of backends()) {
  describe(`${backend.name} 02-store §2 — vendo_audit append-only routing`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("rejects put for an existing id through the routed door", async () => {
      const audit = made.store.records("vendo_audit");
      const original = auditFixture("aud_append_put");
      await audit.put({ id: original.id, data: original });

      const replacement = auditFixture("aud_append_put", { detail: { count: 999 } });
      await expect(audit.put({ id: replacement.id, data: replacement }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      // History is intact: the original event survives untouched.
      expect((await audit.get(original.id))?.data).toEqual(original);
    });

    it("refuses delete through the routed door", async () => {
      const audit = made.store.records("vendo_audit");
      const event = auditFixture("aud_append_delete");
      await audit.put({ id: event.id, data: event });

      await expect(audit.delete(event.id))
        .rejects.toMatchObject<VendoError>({ code: "blocked" });
      expect((await audit.get(event.id))?.data).toEqual(event);
    });

    it("enforces the same refusals for ephemeral principals in the overlay", async () => {
      const audit = made.store.records("vendo_audit");
      const event = auditFixture("aud_append_overlay", { principal: anon });
      await audit.put({ id: event.id, data: event });

      const replacement = auditFixture("aud_append_overlay", { principal: anon, detail: { count: 999 } });
      await expect(audit.put({ id: replacement.id, data: replacement }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      await expect(audit.delete(event.id))
        .rejects.toMatchObject<VendoError>({ code: "blocked" });
      expect((await audit.get(event.id))?.data).toEqual(event);
    });

    it("enforces the same append-only refusal through the auditStore helper door", async () => {
      const helper = auditStore(made.store);
      const durable = auditFixture("aud_append_helper");
      await helper.append(durable);
      await expect(helper.append(auditFixture("aud_append_helper", { detail: { count: 999 } })))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });

      const overlayEvent = auditFixture("aud_append_helper_anon", { principal: anon });
      await helper.append(overlayEvent);
      await expect(helper.append(auditFixture("aud_append_helper_anon", { principal: anon, detail: { count: 999 } })))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await made.store.records("vendo_audit").get(overlayEvent.id))?.data).toEqual(overlayEvent);
    });

    it("erases audit rows only through the store erase API (02 §5)", async () => {
      const audit = made.store.records("vendo_audit");
      const subject = "user_audit_erase";
      const event = auditFixture("aud_append_erase", { principal: { kind: "user", subject } });
      await audit.put({ id: event.id, data: event });

      const report = await eraseStore(made.store).bySubject(subject);
      expect(report.vendo_audit).toBe(1);
      expect(await audit.get(event.id)).toBeNull();
    });
  });
}
