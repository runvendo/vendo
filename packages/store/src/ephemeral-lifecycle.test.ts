import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, approvalFixture, at, auditFixture, grantFixture, persistentPrincipal } from "./fixtures.test-util.js";
import {
  appStore, approvalStore, auditStore, createStore, grantStore, runStore, stateStore, threadStore,
  type VendoStore,
} from "./index.js";
import {
  appEphemerality,
  beginEphemeralRequest,
  endEphemeralRequest,
  ephemeralOverlaySizes,
  evictEphemeralSubject,
  isEphemeralSubject,
  overlayFor,
  registerEphemeralSubject,
  setSessionCap,
  sweepEphemeralSubjects,
} from "./ephemeral.js";
import { dbFor } from "./store.js";

const memoryStore = (): VendoStore => createStore({ dataDir: "memory://" });

describe("ephemeral session registry (ENG-237)", () => {
  it("registration stamps touchedAt and touch refreshes it + LRU recency", () => {
    const store = memoryStore();
    registerEphemeralSubject(store, "a", 1000);
    registerEphemeralSubject(store, "b", 2000);
    expect([...overlayFor(store).subjects.keys()]).toEqual(["a", "b"]);
    expect(overlayFor(store).subjects.get("a")?.touchedAt).toBe(1000);

    registerEphemeralSubject(store, "a", 3000); // touch a
    expect(overlayFor(store).subjects.get("a")?.touchedAt).toBe(3000);
    // a is now the most-recent (last) entry; b became the oldest.
    expect([...overlayFor(store).subjects.keys()]).toEqual(["b", "a"]);
  });

  it("inflight refcount survives a re-touch and floors at zero", () => {
    const store = memoryStore();
    registerEphemeralSubject(store, "a", 1000);
    beginEphemeralRequest(store, "a");
    beginEphemeralRequest(store, "a");
    registerEphemeralSubject(store, "a", 2000); // re-touch mid-flight
    expect(overlayFor(store).subjects.get("a")?.inflight).toBe(2);
    endEphemeralRequest(store, "a");
    endEphemeralRequest(store, "a");
    endEphemeralRequest(store, "a"); // extra end never goes negative
    expect(overlayFor(store).subjects.get("a")?.inflight).toBe(0);
  });

  it("sweep evicts only idle, long-enough, not-inflight subjects and returns them", () => {
    const store = memoryStore();
    registerEphemeralSubject(store, "old", 0);
    registerEphemeralSubject(store, "fresh", 1000);
    registerEphemeralSubject(store, "busy", 0);
    beginEphemeralRequest(store, "busy");

    const evicted = sweepEphemeralSubjects(store, { idleMs: 500, now: 1000 });
    expect(evicted).toEqual(["old"]); // 1000-0 >= 500, not inflight
    expect(isEphemeralSubject(store, "old")).toBe(false);
    expect(isEphemeralSubject(store, "fresh")).toBe(true); // 1000-1000 < 500
    expect(isEphemeralSubject(store, "busy")).toBe(true); // idle but inflight

    endEphemeralRequest(store, "busy");
    expect(sweepEphemeralSubjects(store, { idleMs: 500, now: 1000 })).toEqual(["busy"]);
  });

  it("cap overflow skips inflight subjects (a mid-stream session is never evicted)", () => {
    const store = memoryStore();
    registerEphemeralSubject(store, "streaming", 0, 10);
    beginEphemeralRequest(store, "streaming"); // oldest, but mid-turn
    registerEphemeralSubject(store, "idle", 100, 10);
    registerEphemeralSubject(store, "new", 200, 2); // over cap → evict oldest NOT-inflight
    expect(isEphemeralSubject(store, "streaming")).toBe(true); // survived — inflight
    expect(isEphemeralSubject(store, "idle")).toBe(false);
    expect(isEphemeralSubject(store, "new")).toBe(true);

    // If everything else is inflight, the registry exceeds the cap rather than
    // evicting a live session; the next sweep/registration reclaims it.
    beginEphemeralRequest(store, "new");
    registerEphemeralSubject(store, "another", 300, 2);
    expect(overlayFor(store).subjects.size).toBe(3); // streaming + new + another
    expect(isEphemeralSubject(store, "streaming")).toBe(true);
    endEphemeralRequest(store, "streaming");
    registerEphemeralSubject(store, "another", 400, 2); // re-touch enforces the cap again
    expect(isEphemeralSubject(store, "streaming")).toBe(false);
    expect(overlayFor(store).subjects.size).toBe(2);
  });

  it("setSessionCap governs registrations that pass no explicit cap", () => {
    const store = memoryStore();
    setSessionCap(store, 2);
    registerEphemeralSubject(store, "a", 0); // store-internal style: no cap arg
    registerEphemeralSubject(store, "b", 100);
    registerEphemeralSubject(store, "c", 200);
    expect(isEphemeralSubject(store, "a")).toBe(false); // oldest evicted at cap 2
    expect(overlayFor(store).subjects.size).toBe(2);
  });
});

describe("ephemeral cascade eviction empties every overlay map for exactly one subject (ENG-237)", () => {
  const seed = async (store: VendoStore, tag: string): Promise<Principal> => {
    const subject = `sess_${tag}`;
    const principal: Principal = { kind: "user", subject, ephemeral: true };
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

  it("clears S1's rows across all ten maps and leaves S2 untouched", async () => {
    const store = memoryStore();
    await store.ensureSchema();
    const s1 = await seed(store, "s1");
    await seed(store, "s2");
    // Every map now holds one row per subject.
    for (const [name, size] of Object.entries(ephemeralOverlaySizes(store))) {
      expect(size, name).toBe(2);
    }

    evictEphemeralSubject(store, s1.subject);

    // Exactly S1's data is gone; S2's remains — every map back to one row.
    for (const [name, size] of Object.entries(ephemeralOverlaySizes(store))) {
      expect(size, name).toBe(1);
    }
    expect(isEphemeralSubject(store, s1.subject)).toBe(false);
    expect(isEphemeralSubject(store, "sess_s2")).toBe(true);
    expect(overlayFor(store).records.has("app:app_s1:notes")).toBe(false);
    expect(overlayFor(store).records.has("app:app_s2:notes")).toBe(true);
    expect(overlayFor(store).blobs.has("app:app_s1:files")).toBe(false);
    expect(overlayFor(store).blobs.has("app:app_s2:files")).toBe(true);
    // S2 still reads back through the normal ephemeral path.
    expect((await store.records("app:app_s2:notes").get("note_s2"))?.data).toEqual({ v: "s2" });
  });

  it("cap overflow runs the full cascade (no orphaned overlay data)", async () => {
    const store = memoryStore();
    await store.ensureSchema();
    await seed(store, "over1");
    expect(overlayFor(store).apps.has("app_over1")).toBe(true);
    // Register a second subject with cap=1 so the oldest (over1) overflows.
    registerEphemeralSubject(store, "sess_over2", 9999, 1);
    expect(isEphemeralSubject(store, "sess_over1")).toBe(false);
    // The cascade — not the old key-only drop — cleaned every overlay map.
    expect(overlayFor(store).apps.has("app_over1")).toBe(false);
    expect(overlayFor(store).records.has("app:app_over1:notes")).toBe(false);
    expect(overlayFor(store).blobs.has("app:app_over1:files")).toBe(false);
    expect(overlayFor(store).threads.has("thr_over1")).toBe(false);
  });
});

// Task 3: the STORE-1 disk-leak pin — runs on BOTH backends (real Postgres when
// POSTGRES_URL is set) so the fail-closed guarantee is proven on disk, not just
// in the overlay.
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

    it("evicted-session writes fail closed and leave zero disk rows; reads return empty", async () => {
      const principal: Principal = { kind: "user", subject: "sess_leak", ephemeral: true };
      await appStore(made.store).put(principal, appFixture("app_leak", "Leak"));
      const records = made.store.records("app:app_leak:notes");
      const blobs = made.store.blobs("app:app_leak:files");
      await records.put({ id: "n1", data: { text: "temp" } });
      await blobs.put("f.txt", new Uint8Array([1]));
      expect(await diskRecords("app:app_leak:notes")).toBe(0);
      expect(await diskBlobs("app:app_leak:files")).toBe(0);
      expect(await appEphemerality(made.store, dbFor(made.store), "app_leak")).toBe("ephemeral");

      // Session expires.
      evictEphemeralSubject(made.store, principal.subject);
      expect(await appEphemerality(made.store, dbFor(made.store), "app_leak")).toBe("unknown");

      // Stale writes refuse instead of routing to disk (the STORE-1 leak).
      await expect(records.put({ id: "n2", data: { text: "stale" } })).rejects.toThrow(/session may have expired/);
      await expect(records.delete("n1")).rejects.toThrow(/session may have expired/);
      await expect(blobs.put("g.txt", new Uint8Array([2]))).rejects.toThrow(/session may have expired/);
      await expect(blobs.delete("f.txt")).rejects.toThrow(/session may have expired/);
      if (records.atomic) {
        await expect(records.atomic.insertIfAbsent({ id: "n3", data: { text: "stale" } }))
          .rejects.toThrow(/session may have expired/);
      }

      // Nothing leaked to disk on either backend.
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
