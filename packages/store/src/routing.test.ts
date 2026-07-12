import { VendoError, auditEventSchema, permissionGrantSchema, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { approvalFixture, at, auditFixture, grantFixture } from "./fixtures.test-util.js";
import { auditStore, grantStore, registerEphemeralSubject } from "./index.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("routes grants into vendo_grants and synthesizes authoritative refs", async () => {
      const grant = grantFixture("grt_routed", { subject: "user_route", tool: "host_route", appId: "app_route" });
      const record = await made.store.records("vendo_grants").put({
        id: grant.id,
        data: grant,
        refs: { subject: "ignored", tool: "ignored" },
      });
      expect(permissionGrantSchema.parse(record.data)).toEqual(grant);
      expect(record.refs).toEqual({ subject: "user_route", tool: "host_route", app_id: "app_route" });
      expect(await made.sql("SELECT subject, tool, app_id FROM vendo_grants WHERE id = $1", [grant.id]))
        .toEqual([{ subject: "user_route", tool: "host_route", app_id: "app_route" }]);
      expect(Number((await made.sql("SELECT COUNT(*)::int AS count FROM vendo_records WHERE id = $1", [grant.id]))[0]?.count)).toBe(0);
    });

    it("routes and updates approvals with subject and status refs", async () => {
      const request = approvalFixture("apr_routed", {
        ctx: { principal: { kind: "user", subject: "user_approval" }, venue: "chat", presence: "present", appId: "app_test" },
      });
      const approvals = made.store.records("vendo_approvals");
      await approvals.put({ id: request.id, data: { request, status: "pending" } });
      expect(await made.sql("SELECT subject, status FROM vendo_approvals WHERE id = $1", [request.id]))
        .toEqual([{ subject: "user_approval", status: "pending" }]);
      expect((await approvals.list({ refs: { subject: "user_approval", status: "pending" } })).records.map((r) => r.id))
        .toEqual([request.id]);

      const decidedAt = at(45);
      await approvals.put({ id: request.id, data: { request, status: "approved", decidedAt } });
      expect((await approvals.get(request.id))?.data).toEqual({ request, status: "approved", decidedAt });
      expect((await approvals.list({ refs: { status: "approved" } })).records.map((r) => r.id)).toContain(request.id);
    });

    it("routes audit events and supports refs-filtered lists", async () => {
      const event = auditFixture("aud_routed", { principal: { kind: "user", subject: "user_route" }, tool: "host_route" });
      const audit = made.store.records("vendo_audit");
      await audit.put({ id: event.id, data: event });
      expect(auditEventSchema.parse((await audit.get(event.id))?.data)).toEqual(event);
      expect(await made.sql("SELECT subject, kind, tool FROM vendo_audit WHERE id = $1", [event.id]))
        .toEqual([{ subject: "user_route", kind: "tool-call", tool: "host_route" }]);
      expect((await audit.list({ refs: { subject: "user_route", kind: "tool-call", tool: "host_route" } })).records.map((r) => r.id))
        .toContain(event.id);
    });

    it("rejects malformed routed data, unknown refs, and embedded-id mismatches", async () => {
      await expect(made.store.records("vendo_grants").put({ id: "grt_bad", data: { id: "grt_bad" } }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      await expect(made.store.records("vendo_grants").list({ refs: { made_up: "x" } }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      await expect(made.store.records("vendo_grants").put({ id: "grt_outer", data: grantFixture("grt_inner") }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });

    it("keeps routed rows and typed helpers in one shared world", async () => {
      const routedGrant = grantFixture("grt_world_route", { subject: "user_world" });
      await made.store.records("vendo_grants").put({ id: routedGrant.id, data: routedGrant });
      expect(await grantStore(made.store).get(routedGrant.id)).toEqual(routedGrant);

      const helperEvent = auditFixture("aud_world_helper", { principal: { kind: "user", subject: "user_world" } });
      await auditStore(made.store).append(helperEvent);
      expect((await made.store.records("vendo_audit").get(helperEvent.id))?.data).toEqual(helperEvent);
    });

    it("routes vendo_threads through the typed table with subject-scoped composite keys", async () => {
      const threads = made.store.records("vendo_threads");
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];

      // Two subjects sharing one host-fixed thread id stay isolated rows.
      const a = await threads.put({
        id: "user_thread_a:thr_shared",
        data: { subject: "user_thread_a", messages },
      });
      const b = await threads.put({
        id: "user_thread_b:thr_shared",
        data: { subject: "user_thread_b", messages: [] },
      });
      expect(a.refs).toEqual({ subject: "user_thread_a" });
      expect(await threads.get("user_thread_a:thr_shared")).toEqual(a);
      expect(await threads.get("user_thread_b:thr_shared")).toEqual(b);
      expect(await made.sql(
        "SELECT id, subject FROM vendo_threads WHERE id = $1 ORDER BY subject", ["thr_shared"],
      )).toEqual([
        { id: "thr_shared", subject: "user_thread_a" },
        { id: "thr_shared", subject: "user_thread_b" },
      ]);
      expect((await threads.list({ refs: { subject: "user_thread_a" } })).records).toEqual([a]);
      await threads.delete("user_thread_a:thr_shared");
      expect(await threads.get("user_thread_a:thr_shared")).toBeNull();
      expect(await threads.get("user_thread_b:thr_shared")).toEqual(b);

      // Subjects with ':' and '%' (OIDC urn:/auth0 subs) round-trip via the escaped key.
      const urnSubject = "urn:auth0:us%er|9";
      const key = `${urnSubject.replaceAll("%", "%25").replaceAll(":", "%3A")}:thr_urn`;
      const c = await threads.put({ id: key, data: { subject: urnSubject, messages } });
      expect(c.id).toBe(key);
      expect(await threads.get(key)).toEqual(c);
      expect(await made.sql("SELECT id, subject FROM vendo_threads WHERE id = $1", ["thr_urn"]))
        .toEqual([{ id: "thr_urn", subject: urnSubject }]);

      // The record subject must match the key's subject segment.
      await expect(threads.put({
        id: "user_thread_a:thr_forged",
        data: { subject: "user_thread_b", messages: [] },
      })).rejects.toMatchObject({ code: "validation" });
    });

    it("routes vendo_state through the typed table with composite keys", async () => {
      const states = made.store.records("vendo_state");
      const id = "app_state:user_state";
      const written = await states.put({
        id,
        data: { selected: "invoice_42" },
        refs: { app_id: "ignored", subject: "ignored" },
      });

      expect(written).toMatchObject({
        id,
        data: { selected: "invoice_42" },
        refs: { app_id: "app_state", subject: "user_state" },
      });
      expect(await states.get(id)).toEqual(written);
      expect((await states.list({ refs: { app_id: "app_state", subject: "user_state" } })).records)
        .toEqual([written]);
      expect(await made.sql("SELECT app_id, subject, data FROM vendo_state WHERE app_id = $1 AND subject = $2", ["app_state", "user_state"]))
        .toEqual([{ app_id: "app_state", subject: "user_state", data: { selected: "invoice_42" } }]);
      expect(Number((await made.sql("SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = 'vendo_state' AND id = $1", [id]))[0]?.count)).toBe(0);

      await states.delete(id);
      expect(await states.get(id)).toBeNull();
    });

    it("cascades typed state when deleting through the routed app collection", async () => {
      const appId = "app_state_cascade";
      const subject = "user_state_cascade";
      await made.store.records("vendo_state").put({ id: `${appId}:${subject}`, data: { dirty: true } });
      await made.store.records("vendo_apps").delete(appId);
      expect(await made.store.records("vendo_state").get(`${appId}:${subject}`)).toBeNull();
    });

    it("walks newest-first routed pages without duplicates or misses", async () => {
      const grants = made.store.records("vendo_grants");
      const ids = Array.from({ length: 15 }, (_, index) => `grt_page_${String(index).padStart(2, "0")}`);
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index] as string;
        await grants.put({ id, data: grantFixture(id, { subject: "user_pages", grantedAt: at(index) }) });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await grants.list({ refs: { subject: "user_pages" }, limit: 5, cursor });
        seen.push(...page.records.map((record) => record.id));
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(seen).toEqual([...ids].reverse());
      expect(new Set(seen).size).toBe(ids.length);
    });

    it("leaves near-match collection names in vendo_records", async () => {
      await made.store.records("vendo_grants_x").put({ id: "ordinary_row", data: { ordinary: true } });
      expect(await made.sql("SELECT collection, data FROM vendo_records WHERE id = 'ordinary_row'"))
        .toEqual([{ collection: "vendo_grants_x", data: { ordinary: true } }]);
    });

    it("keeps principal-aware and registered routed writes ephemeral", async () => {
      const ephemeral: Principal = { kind: "user", subject: "sess_route", ephemeral: true };
      const request = approvalFixture("apr_ephemeral_route", {
        ctx: { principal: ephemeral, venue: "chat", presence: "present" },
      });
      await made.store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      expect((await made.store.records("vendo_approvals").get(request.id))?.id).toBe(request.id);
      expect(Number((await made.sql("SELECT COUNT(*)::int AS count FROM vendo_approvals WHERE id = $1", [request.id]))[0]?.count)).toBe(0);

      registerEphemeralSubject(made.store, ephemeral.subject);
      const grant = grantFixture("grt_ephemeral_route", { subject: ephemeral.subject });
      await made.store.records("vendo_grants").put({ id: grant.id, data: grant });
      expect(await grantStore(made.store).get(grant.id)).toEqual(grant);
      expect(Number((await made.sql("SELECT COUNT(*)::int AS count FROM vendo_grants WHERE id = $1", [grant.id]))[0]?.count)).toBe(0);
    });
  });
}
