import { VendoError } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { orgStore } from "./orgs.js";

for (const backend of backends()) {
  describe(`orgStore (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("creates an org with the creator as owner and lists it by member", async () => {
      const orgs = orgStore(made.store);
      const org = await orgs.create("  Acme Corp  ", "user_ada");
      expect(org.id).toMatch(/^org_[0-9a-f]{32}$/);
      expect(org.name).toBe("Acme Corp"); // trimmed
      expect(await orgs.get(org.id)).toEqual(org);
      expect(await orgs.roleOf(org.id, "user_ada")).toBe("owner");
      expect(await orgs.listByMember("user_ada")).toEqual([{ ...org, role: "owner" }]);
      expect(await orgs.listByMember("user_bob")).toEqual([]);
    });

    it("rejects empty/oversized names and reserved owner subjects", async () => {
      const orgs = orgStore(made.store);
      await expect(orgs.create("   ", "user_ada")).rejects.toMatchObject({ code: "validation" });
      await expect(orgs.create("x".repeat(201), "user_ada")).rejects.toMatchObject({ code: "validation" });
      for (const subject of ["vendo:webhook:stripe", "vendo:org:org_1", "webhook:stripe", ""]) {
        await expect(orgs.create("Acme", subject)).rejects.toMatchObject({ code: "validation" });
      }
    });

    it("adds members with roles, refuses duplicates and reserved subjects", async () => {
      const orgs = orgStore(made.store);
      const org = await orgs.create("Members Inc", "user_ada");
      const member = await orgs.addMember(org.id, "user_bob", "member");
      expect(member).toMatchObject({ orgId: org.id, subject: "user_bob", role: "member" });
      await orgs.addMember(org.id, "user_cleo", "admin");
      expect((await orgs.members(org.id)).map((entry) => [entry.subject, entry.role])).toEqual([
        ["user_ada", "owner"], ["user_bob", "member"], ["user_cleo", "admin"],
      ]);
      await expect(orgs.addMember(org.id, "user_bob", "admin")).rejects.toMatchObject({ code: "conflict" });
      await expect(orgs.addMember(org.id, "vendo:webhook:github", "member"))
        .rejects.toMatchObject({ code: "validation" });
      await expect(orgs.addMember(org.id, "user_x", "superadmin" as never))
        .rejects.toMatchObject({ code: "validation" });
      await expect(orgs.addMember("org_missing", "user_x", "member"))
        .rejects.toMatchObject({ code: "not-found" });
    });

    it("changes roles but never orphans the org of its last owner", async () => {
      const orgs = orgStore(made.store);
      const org = await orgs.create("Solo LLC", "user_ada");
      await orgs.addMember(org.id, "user_bob", "member");

      // Promote bob, demote ada — fine while another owner exists.
      await orgs.setRole(org.id, "user_bob", "owner");
      await orgs.setRole(org.id, "user_ada", "admin");
      expect(await orgs.roleOf(org.id, "user_ada")).toBe("admin");

      // bob is now the LAST owner: demoting or removing him refuses.
      await expect(orgs.setRole(org.id, "user_bob", "member")).rejects.toMatchObject({ code: "conflict" });
      await expect(orgs.removeMember(org.id, "user_bob")).rejects.toMatchObject({ code: "conflict" });
      expect(await orgs.roleOf(org.id, "user_bob")).toBe("owner");

      // Non-owners come and go freely; unknown members are not-found.
      await orgs.removeMember(org.id, "user_ada");
      expect(await orgs.roleOf(org.id, "user_ada")).toBe(null);
      await expect(orgs.removeMember(org.id, "user_ada")).rejects.toMatchObject({ code: "not-found" });
      await expect(orgs.setRole(org.id, "user_ghost", "admin")).rejects.toMatchObject({ code: "not-found" });
    });

    it("surfaces role integrity as VendoError, not raw db failures", async () => {
      const orgs = orgStore(made.store);
      const org = await orgs.create("Errors Org", "user_ada");
      const failure = await orgs.setRole(org.id, "user_ada", "chief" as never).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VendoError);
    });

    it("erase cascades: by-subject removes memberships (even a last owner); erasing an org subject removes the org", async () => {
      const { eraseStore } = await import("../erase.js");
      const orgs = orgStore(made.store);
      const org = await orgs.create("Erase Org", "user_erase_owner");
      await orgs.addMember(org.id, "user_erase_member", "member");

      // Full erasure wins over the last-owner invariant (02 §5).
      const report = await eraseStore(made.store).bySubject("user_erase_owner");
      expect(report.vendo_org_members).toBe(1);
      expect(await orgs.roleOf(org.id, "user_erase_owner")).toBe(null);
      expect(await orgs.roleOf(org.id, "user_erase_member")).toBe("member");
      expect(await orgs.get(org.id)).not.toBe(null); // org row survives member erasure

      // Erasing the ORG subject removes the org and its remaining memberships.
      const orgReport = await eraseStore(made.store).bySubject(`vendo:org:${org.id}`);
      expect(orgReport.vendo_orgs).toBe(1);
      expect(orgReport.vendo_org_members).toBe(1);
      expect(await orgs.get(org.id)).toBe(null);
    });
  });
}
