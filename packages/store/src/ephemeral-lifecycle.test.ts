import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, approvalFixture, at, auditFixture, grantFixture, persistentPrincipal } from "./fixtures.test-util.js";
import {
  appStore, approvalStore, auditStore, createStore, grantStore, registerEphemeralSubject,
  runStore, stateStore, sweepEphemeralSubjects, threadStore,
  type VendoStore,
} from "./index.js";

const memoryStore = async (): Promise<VendoStore> => {
  const store = createStore({ dataDir: "memory://" });
  await store.ensureSchema();
  return store;
};

// Kill-list B3: the session registry is a disk table (vendo_sessions). A
// register is a touch (last-activity stamp); the sweep erases every subject
// idle past the TTL through the erase cascade. The overlay-only mechanics
// (LRU cap, inflight brackets, process-local eviction) are gone.
describe("ephemeral session registry (kill-list B3)", () => {
  it("registration stamps the touch time and re-registration refreshes it", async () => {
    const store = await memoryStore();
    await registerEphemeralSubject(store, "old", 0);
    await registerEphemeralSubject(store, "fresh", 1000);

    // old is 1000ms idle at now=1000 — swept; fresh is 0ms idle — kept.
    expect(await sweepEphemeralSubjects(store, { idleMs: 500, now: 1000 })).toEqual(["old"]);

    // A touch refreshes the clock: fresh re-registered at 1400 survives a sweep
    // at 1800 (400ms idle), then falls to one at 2000 (600ms idle).
    await registerEphemeralSubject(store, "fresh", 1400);
    expect(await sweepEphemeralSubjects(store, { idleMs: 500, now: 1800 })).toEqual([]);
    expect(await sweepEphemeralSubjects(store, { idleMs: 500, now: 2000 })).toEqual(["fresh"]);
    await store.close();
  });

  it("a swept subject that returns gets a fresh registration", async () => {
    const store = await memoryStore();
    await registerEphemeralSubject(store, "revenant", 0);
    expect(await sweepEphemeralSubjects(store, { idleMs: 100, now: 1000 })).toEqual(["revenant"]);
    await registerEphemeralSubject(store, "revenant", 1100);
    expect(await sweepEphemeralSubjects(store, { idleMs: 100, now: 1150 })).toEqual([]);
    expect(await sweepEphemeralSubjects(store, { idleMs: 100, now: 1300 })).toEqual(["revenant"]);
    await store.close();
  });
});

describe("the sweep erases every table for exactly the stale subject (kill-list B3)", () => {
  const seed = async (store: VendoStore, tag: string, touchedAt: number): Promise<Principal> => {
    const subject = `sess_${tag}`;
    const principal: Principal = { kind: "user", subject, ephemeral: true };
    await registerEphemeralSubject(store, subject, touchedAt);
    const appId = `app_${tag}`;
    const doc = appFixture(appId, tag);
    await appStore(store).put(principal, doc);
    await stateStore(store).put(principal, appId, { v: tag });
    await threadStore(store).put(principal, { id: `thr_${tag}`, messages: [{ text: tag }] });
    await grantStore(store).create(principal, grantFixture(`grt_${tag}`, { subject, appId }));
    await auditStore(store).append(auditFixture(`aud_${tag}`, { principal, appId }));
    await approvalStore(store).create(approvalFixture(`apr_${tag}`, {
      ctx: { principal, venue: "chat", presence: "present", appId },
    }));
    await runStore(store).put({
      id: `run_${tag}`, appId, trigger: { kind: "schedule" }, status: "running",
      record: { v: tag }, startedAt: at(50),
    });
    await store.records(`app:${appId}:notes`).put({ id: `note_${tag}`, data: { v: tag } });
    await store.blobs(`app:${appId}:files`).put(`${tag}.txt`, new Uint8Array([1]));
    return principal;
  };

  it("clears S1's rows everywhere and leaves S2 untouched", async () => {
    const store = await memoryStore();
    const s1 = await seed(store, "s1", 0);
    const s2 = await seed(store, "s2", 5000);

    expect(await sweepEphemeralSubjects(store, { idleMs: 1000, now: 2000 })).toEqual([s1.subject]);

    // Exactly S1's data is gone…
    expect(await appStore(store).get("app_s1")).toBeNull();
    expect(await stateStore(store).get(s1, "app_s1")).toBeNull();
    expect(await threadStore(store).get(s1, "thr_s1")).toBeNull();
    expect(await grantStore(store).get("grt_s1")).toBeNull();
    expect((await auditStore(store).query({ principal: s1 })).events).toEqual([]);
    expect(await approvalStore(store).pending(s1)).toEqual([]);
    expect(await runStore(store).get("run_s1")).toBeNull();
    expect(await store.records("app:app_s1:notes").get("note_s1")).toBeNull();
    expect(await store.blobs("app:app_s1:files").get("s1.txt")).toBeNull();
    // …and S2 still reads back through every door.
    expect((await appStore(store).get("app_s2"))?.subject).toBe(s2.subject);
    expect((await store.records("app:app_s2:notes").get("note_s2"))?.data).toEqual({ v: "s2" });
    expect(await store.blobs("app:app_s2:files").get("s2.txt")).not.toBeNull();
    expect((await threadStore(store).get(s2, "thr_s2"))?.subject).toBe(s2.subject);
    await store.close();
  });
});

// The STORE-1 disk-orphan pin — runs on BOTH backends (real Postgres when
// POSTGRES_URL is set): once a session is swept, its apps are GONE from
// vendo_apps, so stale app-scoped writes fail closed instead of recreating
// orphaned rows that no cascade would ever clean.
for (const backend of backends()) {
  describe(`fail-closed unknown-app routing (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const diskRecords = async (collection: string): Promise<number> => Number(
      (await made.sql("SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = $1", [collection]))[0]?.["count"],
    );
    const diskBlobs = async (namespace: string): Promise<number> => Number(
      (await made.sql("SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = $1", [namespace]))[0]?.["count"],
    );

    it("post-sweep writes fail closed and leave zero orphaned rows; reads return empty", async () => {
      const principal: Principal = { kind: "user", subject: "sess_leak", ephemeral: true };
      await registerEphemeralSubject(made.store, principal.subject, 0);
      await appStore(made.store).put(principal, appFixture("app_leak", "Leak"));
      const records = made.store.records("app:app_leak:notes");
      const blobs = made.store.blobs("app:app_leak:files");
      await records.put({ id: "n1", data: { text: "temp" } });
      await blobs.put("f.txt", new Uint8Array([1]));
      expect(await diskRecords("app:app_leak:notes")).toBe(1);
      expect(await diskBlobs("app:app_leak:files")).toBe(1);

      // Session expires.
      expect(await sweepEphemeralSubjects(made.store, { idleMs: 1, now: 10_000 })).toEqual([principal.subject]);

      // Stale writes refuse instead of recreating rows for a dead app.
      await expect(records.put({ id: "n2", data: { text: "stale" } })).rejects.toThrow(/session may have expired/);
      await expect(records.delete("n1")).rejects.toThrow(/session may have expired/);
      await expect(blobs.put("g.txt", new Uint8Array([2]))).rejects.toThrow(/session may have expired/);
      await expect(blobs.delete("f.txt")).rejects.toThrow(/session may have expired/);
      if (records.atomic) {
        await expect(records.atomic.insertIfAbsent({ id: "n3", data: { text: "stale" } }))
          .rejects.toThrow(/session may have expired/);
      }

      // Nothing survived or leaked on either backend.
      expect(await diskRecords("app:app_leak:notes")).toBe(0);
      expect(await diskBlobs("app:app_leak:files")).toBe(0);

      // Reads on the expired session are empty, not an error storm.
      expect(await records.get("n1")).toBeNull();
      expect((await records.list()).records).toEqual([]);
      expect(await blobs.get("f.txt")).toBeNull();
      expect(await blobs.list()).toEqual([]);
    });

    it("durable apps still write to disk (fail-closed only bites unknown apps)", async () => {
      await appStore(made.store).put(persistentPrincipal, appFixture("app_dur", "Durable"));
      const records = made.store.records("app:app_dur:notes");
      await records.put({ id: "d1", data: { text: "kept" } });
      expect((await records.get("d1"))?.data).toEqual({ text: "kept" });
      expect(await diskRecords("app:app_dur:notes")).toBe(1);
    });

    it("non-app-scoped collections are always durable (unaffected)", async () => {
      const records = made.store.records("vendo_mcp_clients");
      await records.put({ id: "mcp_1", data: { ok: true } });
      expect((await records.get("mcp_1"))?.data).toEqual({ ok: true });
    });
  });
}
