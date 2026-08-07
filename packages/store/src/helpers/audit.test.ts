import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { at, auditFixture, persistentPrincipal } from "../fixtures.test-util.js";
import { auditStore } from "./audit.js";

for (const backend of backends()) {
  describe(`auditStore (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("appends a persistent event and reads it back through query()", async () => {
      const audit = auditStore(made.store);
      const event = auditFixture("aud_basic", { at: at(1) });
      await audit.append(event);
      const result = await audit.query({ principal: persistentPrincipal });
      expect(result.events).toContainEqual(event);
    });

    it("filters query() by principal, appId, kind, and an inclusive from/to range", async () => {
      const audit = auditStore(made.store);
      const other: Principal = { kind: "user", subject: "user_audit_filter_other" };
      const events = [
        auditFixture("aud_persist_1", { at: at(10), kind: "tool-call", appId: "app_persist", tool: "host_a" }),
        auditFixture("aud_persist_2", { at: at(11), kind: "approval", appId: "app_persist" }),
        auditFixture("aud_persist_3", { at: at(12), kind: "tool-call", appId: "app_other_persist" }),
        auditFixture("aud_persist_4", { at: at(13), kind: "tool-call", appId: "app_persist", principal: other }),
      ];
      for (const event of events) await audit.append(event);

      expect((await audit.query({ principal: persistentPrincipal, kind: "tool-call", appId: "app_persist" }))
        .events.map((event) => event.id)).toEqual(["aud_persist_1"]);
      expect((await audit.query({ principal: persistentPrincipal, appId: "app_persist" }))
        .events.map((event) => event.id).sort()).toEqual(["aud_persist_1", "aud_persist_2"]);
      expect((await audit.query({ principal: other })).events.map((event) => event.id)).toEqual(["aud_persist_4"]);
      expect((await audit.query({ principal: persistentPrincipal, from: at(11), to: at(12) }))
        .events.map((event) => event.id).sort()).toEqual(["aud_persist_2", "aud_persist_3"]);
      // Boundary values are inclusive on both ends.
      expect((await audit.query({ principal: persistentPrincipal, from: at(10), to: at(10) }))
        .events.map((event) => event.id)).toEqual(["aud_persist_1"]);
    });

    it("queries with no principal filter at all, scanning across subjects", async () => {
      const audit = auditStore(made.store);
      const other: Principal = { kind: "user", subject: "user_audit_scan_other" };
      await audit.append(auditFixture("aud_scan_mine", { at: at(20), appId: "app_scan" }));
      await audit.append(auditFixture("aud_scan_other", { at: at(21), appId: "app_scan", principal: other }));
      const scanned = await audit.query({ appId: "app_scan" });
      expect(scanned.events.map((event) => event.id).sort()).toEqual(["aud_scan_mine", "aud_scan_other"]);
    });

    it("paginates query() for a persistent principal with a stable cursor, newest first", async () => {
      const audit = auditStore(made.store);
      for (let i = 0; i < 5; i += 1) {
        await audit.append(auditFixture(`aud_page_${i}`, { at: at(30 + i), appId: "app_paginate" }));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await audit.query({ principal: persistentPrincipal, appId: "app_paginate", limit: 2, cursor });
        expect(page.events.length).toBeLessThanOrEqual(2);
        seen.push(...page.events.map((event) => event.id));
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual(["aud_page_4", "aud_page_3", "aud_page_2", "aud_page_1", "aud_page_0"]);
    });

    it("appends ephemeral-principal events to disk like any other (kill-list B3)", async () => {
      const ephemeral: Principal = { kind: "user", subject: "sess_audit", ephemeral: true };
      const audit = auditStore(made.store);
      const event = auditFixture("aud_ephemeral_basic", { at: at(40), principal: ephemeral, appId: "app_audit_ephemeral" });
      await audit.append(event);
      expect((await audit.query({ principal: ephemeral })).events).toContainEqual(event);
      const rows = await made.sql("SELECT COUNT(*)::int AS count FROM vendo_audit WHERE subject = $1", [ephemeral.subject]);
      expect(Number(rows[0]?.["count"])).toBe(1);
    });

    it("filters and paginates ephemeral query() by appId, kind, from/to, and cursor", async () => {
      const ephemeral: Principal = { kind: "user", subject: "sess_audit_filter", ephemeral: true };
      const audit = auditStore(made.store);
      const events = [
        auditFixture("aud_eph_1", { at: at(41), principal: ephemeral, kind: "tool-call", appId: "app_eph" }),
        auditFixture("aud_eph_2", { at: at(42), principal: ephemeral, kind: "approval", appId: "app_eph" }),
        auditFixture("aud_eph_3", { at: at(43), principal: ephemeral, kind: "tool-call", appId: "app_eph_other" }),
      ];
      for (const event of events) await audit.append(event);

      expect((await audit.query({ principal: ephemeral, kind: "tool-call", appId: "app_eph" }))
        .events.map((event) => event.id)).toEqual(["aud_eph_1"]);
      expect((await audit.query({ principal: ephemeral, from: at(42), to: at(43) }))
        .events.map((event) => event.id)).toEqual(["aud_eph_3", "aud_eph_2"]);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await audit.query({ principal: ephemeral, limit: 1, cursor });
        seen.push(...page.events.map((event) => event.id));
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(seen).toEqual(["aud_eph_3", "aud_eph_2", "aud_eph_1"]);
    });

    it("scopes ephemeral query() to the principal's own subject, ignoring other ephemeral subjects", async () => {
      const mine: Principal = { kind: "user", subject: "sess_audit_mine", ephemeral: true };
      const theirs: Principal = { kind: "user", subject: "sess_audit_theirs", ephemeral: true };
      const audit = auditStore(made.store);
      await audit.append(auditFixture("aud_owner_mine", { at: at(44), principal: mine }));
      await audit.append(auditFixture("aud_owner_theirs", { at: at(45), principal: theirs }));
      expect((await audit.query({ principal: mine })).events.map((event) => event.id)).toEqual(["aud_owner_mine"]);
      expect((await audit.query({ principal: theirs })).events.map((event) => event.id)).toEqual(["aud_owner_theirs"]);
    });

    it("exports events newline-delimited, oldest first, filtered by from/to", async () => {
      const audit = auditStore(made.store);
      const events = [
        auditFixture("aud_export_1", { at: at(46), appId: "app_export" }),
        auditFixture("aud_export_2", { at: at(47), appId: "app_export" }),
        auditFixture("aud_export_3", { at: at(48), appId: "app_export" }),
      ];
      for (const event of events) await audit.append(event);

      const lines: string[] = [];
      for await (const line of audit.export({ from: at(46), to: at(47) })) lines.push(line);
      expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
      expect(lines.map((line) => JSON.parse(line).id)).toEqual(["aud_export_1", "aud_export_2"]);
    });

    it("exports the full unfiltered stream in ascending order when no range is given", async () => {
      const audit = auditStore(made.store);
      await audit.append(auditFixture("aud_export_all_1", { at: at(49) }));
      await audit.append(auditFixture("aud_export_all_2", { at: at(50) }));
      const ids: string[] = [];
      for await (const line of audit.export()) ids.push(JSON.parse(line).id);
      expect(ids.indexOf("aud_export_all_1")).toBeLessThan(ids.indexOf("aud_export_all_2"));
    });

    it("export() terminates and emits each row exactly once across a full batch sharing a microsecond `at`", async () => {
      const audit = auditStore(made.store);
      const microAt = "2026-03-04T05:06:07.123456Z";
      // Bulk host-side append (the §2 table map is public; `at` is
      // z.string().datetime()-validated and accepts sub-ms digits): 501 events
      // share one microsecond-bearing timestamp, spanning the 500-row export
      // batch boundary. The rebuilt cursor rounds through a JS Date to
      // milliseconds, so a full-precision `(at, id) >` predicate re-selects
      // the same batch forever.
      await made.sql(
        `INSERT INTO vendo_audit (id, at, kind, subject, venue, presence, app_id, tool, event)
         SELECT 'aud_exp_micro_' || lpad(n::text, 4, '0'), $1, 'tool-call', $2, 'chat', 'present', 'app_export_micro', 'host_a',
                jsonb_build_object('id', 'aud_exp_micro_' || lpad(n::text, 4, '0'))
         FROM generate_series(1, 501) AS n`,
        [microAt, "user_export_micro"],
      );
      const lines: string[] = [];
      for await (const line of audit.export({ from: microAt, to: microAt })) {
        lines.push(line);
        // Runaway guard: a stuck cursor would re-yield the same batch forever.
        if (lines.length > 1100) break;
      }
      expect(lines).toHaveLength(501);
      expect(new Set(lines).size).toBe(501);
    });

    it("rejects a malformed audit event and never stores it, for persistent or ephemeral principals", async () => {
      const audit = auditStore(made.store);
      const badKind = { ...auditFixture("aud_bad_kind"), kind: "not-a-real-kind" } as never;
      await expect(audit.append(badKind)).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect((await audit.query({ principal: persistentPrincipal })).events)
        .not.toContainEqual(expect.objectContaining({ id: "aud_bad_kind" }));

      const badId = { ...auditFixture("aud_bad_id_placeholder"), id: "not-prefixed-correctly" } as never;
      await expect(audit.append(badId)).rejects.toMatchObject<VendoError>({ code: "validation" });

      const ephemeral: Principal = { kind: "user", subject: "sess_audit_invalid", ephemeral: true };
      const badEphemeral = { ...auditFixture("aud_bad_ephemeral", { principal: ephemeral }), at: "not-a-date" } as never;
      await expect(audit.append(badEphemeral)).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect((await audit.query({ principal: ephemeral })).events)
        .not.toContainEqual(expect.objectContaining({ id: "aud_bad_ephemeral" }));
    });
  });
}
