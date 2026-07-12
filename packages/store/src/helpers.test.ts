import {
  VendoError,
  appDocumentSchema,
  approvalRequestSchema,
  auditEventSchema,
  permissionGrantSchema,
  type Principal,
} from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, approvalFixture, at, auditFixture, grantFixture, persistentPrincipal } from "./fixtures.test-util.js";
import {
  appStore,
  approvalStore,
  auditStore,
  grantStore,
  runStore,
  stateStore,
  threadStore,
} from "./index.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("round-trips app documents and app deletion removes state", async () => {
      const apps = appStore(made.store);
      const states = stateStore(made.store);
      const doc = appFixture("app_helpers", "Helpers");
      const row = await apps.put(persistentPrincipal, doc, { enabled: false });
      expect(appDocumentSchema.parse(row.doc)).toEqual(doc);
      expect(row).toMatchObject({ id: "app_helpers", subject: "user_test", enabled: false });
      expect((await apps.list(persistentPrincipal)).map((app) => app.id)).toContain("app_helpers");
      await states.put(persistentPrincipal, doc.id, { draft: true });
      await apps.delete(doc.id);
      expect(await apps.get(doc.id)).toBeNull();
      expect(await states.get(persistentPrincipal, doc.id)).toBeNull();
    });

    it("isolates state by app and subject and supports delete", async () => {
      const states = stateStore(made.store);
      const other: Principal = { kind: "user", subject: "user_other" };
      await states.put(persistentPrincipal, "app_state_a", { value: "a" });
      await states.put(persistentPrincipal, "app_state_b", { value: "b" });
      await states.put(other, "app_state_a", { value: "other" });
      expect(await states.get(persistentPrincipal, "app_state_a")).toEqual({ value: "a" });
      expect(await states.get(persistentPrincipal, "app_state_b")).toEqual({ value: "b" });
      expect(await states.get(other, "app_state_a")).toEqual({ value: "other" });
      await states.delete(persistentPrincipal, "app_state_a");
      expect(await states.get(persistentPrincipal, "app_state_a")).toBeNull();
      expect(await states.get(other, "app_state_a")).toEqual({ value: "other" });
    });

    it("never exposes threads across subjects", async () => {
      const threads = threadStore(made.store);
      const other: Principal = { kind: "user", subject: "user_thread_other" };
      const row = await threads.put(persistentPrincipal, { id: "thr_helpers", messages: [{ role: "user", text: "hello" }] });
      expect(row.messages).toEqual([{ role: "user", text: "hello" }]);
      expect(await threads.get(persistentPrincipal, "thr_helpers")).toEqual(row);
      expect(await threads.get(other, "thr_helpers")).toBeNull();
      expect((await threads.list(other)).map((thread) => thread.id)).not.toContain("thr_helpers");
      await threads.delete(persistentPrincipal, "thr_helpers");
      expect(await threads.get(persistentPrincipal, "thr_helpers")).toBeNull();
    });

    it("validates grant shapes and filters inactive grants by default", async () => {
      const grants = grantStore(made.store);
      const active = grantFixture("grt_active");
      const expired = grantFixture("grt_expired", { expiresAt: "2020-01-01T00:00:00.000Z" });
      const revoked = grantFixture("grt_revoked", { revokedAt: at(40) });
      await grants.create(persistentPrincipal, active);
      await grants.create(persistentPrincipal, expired);
      await grants.create(persistentPrincipal, revoked);
      expect(permissionGrantSchema.parse(await grants.get(active.id))).toEqual(active);
      expect((await grants.list(persistentPrincipal)).map((grant) => grant.id)).toEqual(["grt_active"]);
      expect((await grants.list(persistentPrincipal, { includeInactive: true })).map((grant) => grant.id).sort())
        .toEqual(["grt_active", "grt_expired", "grt_revoked"]);
      await grants.revoke(active.id, at(41));
      expect((await grants.list(persistentPrincipal)).map((grant) => grant.id)).toEqual([]);
    });

    it("decides only pending approvals, supports batches, and orders pending oldest-first", async () => {
      const approvals = approvalStore(made.store);
      const first = approvalFixture("apr_first", { createdAt: at(1) });
      const second = approvalFixture("apr_second", { createdAt: at(2) });
      const third = approvalFixture("apr_third", { createdAt: at(3) });
      for (const request of [third, first, second]) await approvals.create(request);
      expect((await approvals.pending(persistentPrincipal)).map((request) => request.id)).toEqual([
        "apr_first", "apr_second", "apr_third",
      ]);
      expect(approvalRequestSchema.parse((await approvals.get("apr_first"))?.request)).toEqual(first);
      expect(await approvals.decide("apr_first", "approved", at(10))).toEqual(["apr_first"]);
      expect(await approvals.decide("apr_first", "denied", at(11))).toEqual([]);
      expect(await approvals.decide(["apr_second", "apr_third", "apr_missing"], "denied", at(12)))
        .toEqual(["apr_second", "apr_third"]);
      expect((await approvals.get("apr_first"))?.status).toBe("approved");
      expect(await approvals.pending(persistentPrincipal)).toEqual([]);
    });

    it("filters, paginates, validates, and exports audit events", async () => {
      const audit = auditStore(made.store);
      const other: Principal = { kind: "user", subject: "user_audit_other" };
      const events = [
        auditFixture("aud_filter_1", { at: at(1), kind: "tool-call", tool: "host_a", appId: "app_test" }),
        auditFixture("aud_filter_2", { at: at(2), kind: "approval", tool: "host_b", appId: "app_test" }),
        auditFixture("aud_filter_3", { at: at(3), kind: "tool-call", tool: "host_a", appId: "app_other" }),
        auditFixture("aud_filter_4", { at: at(4), kind: "tool-call", principal: other, tool: "host_a", appId: "app_test" }),
      ];
      for (const event of events) await audit.append(event);
      const filtered = await audit.query({
        principal: persistentPrincipal,
        kind: "tool-call",
        appId: "app_test",
        from: at(1),
        to: at(2),
      });
      expect(filtered.events.map((event) => event.id)).toEqual(["aud_filter_1"]);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await audit.query({ principal: persistentPrincipal, limit: 2, cursor });
        for (const event of page.events) {
          seen.push(auditEventSchema.parse(event).id);
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(seen).toEqual(["aud_filter_3", "aud_filter_2", "aud_filter_1"]);

      const lines: string[] = [];
      for await (const line of audit.export({ from: at(2), to: at(3) })) lines.push(line);
      expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
      expect(lines.map((line) => auditEventSchema.parse(JSON.parse(line)).id)).toEqual(["aud_filter_2", "aud_filter_3"]);
    });

    it("upserts runs in place and filters lists by app and status", async () => {
      const runs = runStore(made.store);
      await runs.put({
        id: "run_helpers",
        appId: "app_runs",
        trigger: { kind: "schedule" },
        status: "running",
        record: { step: 1 },
        startedAt: at(5),
      });
      await runs.put({
        id: "run_helpers",
        appId: "app_runs",
        trigger: { kind: "schedule" },
        status: "ok",
        record: { step: 2 },
        startedAt: at(5),
        finishedAt: at(6),
      });
      await runs.put({
        id: "run_other",
        appId: "app_other",
        trigger: { kind: "host-event", event: "invoice.created" },
        status: "error",
        record: {},
        startedAt: at(7),
      });
      expect(await runs.get("run_helpers")).toMatchObject({ status: "ok", record: { step: 2 }, finishedAt: at(6) });
      const listed = await runs.list({ appId: "app_runs", status: "ok" });
      expect(listed.runs.map((run) => run.id)).toEqual(["run_helpers"]);
    });

    it("rejects malformed typed-helper writes before storing anything", async () => {
      const invalidApp = { ...appFixture("app_invalid", "Invalid"), name: 42 } as never;
      await expect(appStore(made.store).put(persistentPrincipal, invalidApp))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await appStore(made.store).get("app_invalid")).toBeNull();

      await expect(stateStore(made.store).put(persistentPrincipal, "app_invalid_state", undefined as never))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await stateStore(made.store).get(persistentPrincipal, "app_invalid_state")).toBeNull();

      await expect(threadStore(made.store).put(persistentPrincipal, {
        id: "thr_invalid",
        messages: [undefined] as never,
      })).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await threadStore(made.store).get(persistentPrincipal, "thr_invalid")).toBeNull();

      const invalidGrant = { ...grantFixture("grt_invalid"), grantedAt: "not-a-date" } as never;
      await expect(grantStore(made.store).create(persistentPrincipal, invalidGrant))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await grantStore(made.store).get("grt_invalid")).toBeNull();

      const invalidApproval = { ...approvalFixture("apr_invalid"), createdAt: "not-a-date" } as never;
      await expect(approvalStore(made.store).create(invalidApproval))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await approvalStore(made.store).get("apr_invalid")).toBeNull();

      const invalidAudit = { ...auditFixture("aud_invalid"), at: "not-a-date" } as never;
      await expect(auditStore(made.store).append(invalidAudit))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      expect((await auditStore(made.store).query({ principal: persistentPrincipal })).events)
        .not.toContainEqual(expect.objectContaining({ id: "aud_invalid" }));

      await expect(runStore(made.store).put({
        id: "run_invalid",
        appId: "app_invalid",
        trigger: { kind: "schedule" },
        status: "running",
        record: {},
        startedAt: "not-a-date",
      })).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await runStore(made.store).get("run_invalid")).toBeNull();
    });
  });
}
