import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { auditFixture, persistentPrincipal } from "./fixtures.test-util.js";
import { auditStore } from "./index.js";

// 02-store §4 (Retention): OSS retention is host SQL on the host's own cron —
// `DELETE FROM vendo_audit WHERE at < ...`. The table map is public precisely so
// this works, and the helper's query surface must observe the host's deletions.
for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("honors a host DELETE-by-age against vendo_audit through the query surface", async () => {
      const audit = auditStore(made.store);
      const old1 = auditFixture("aud_retain_old_1", { at: "2020-01-01T00:00:00.000Z" });
      const old2 = auditFixture("aud_retain_old_2", { at: "2021-06-15T00:00:00.000Z" });
      const fresh = auditFixture("aud_retain_fresh", { at: "2026-07-12T00:00:00.000Z" });
      for (const event of [old1, old2, fresh]) await audit.append(event);

      // Precondition: all three visible through the helper.
      expect((await audit.query({ principal: persistentPrincipal })).events.map((event) => event.id).sort())
        .toEqual(["aud_retain_fresh", "aud_retain_old_1", "aud_retain_old_2"]);

      // The documented host retention path: raw SQL on the public table.
      const raw = made.store.raw() as { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> };
      await raw.query("DELETE FROM vendo_audit WHERE at < $1", ["2025-01-01T00:00:00.000Z"]);

      // The helper's query surface sees exactly the deletion — only the fresh event survives.
      expect((await audit.query({ principal: persistentPrincipal })).events.map((event) => event.id))
        .toEqual(["aud_retain_fresh"]);
      const remaining = await made.sql("SELECT COUNT(*)::int AS count FROM vendo_audit WHERE subject = $1", [persistentPrincipal.subject]);
      expect(Number(remaining[0]?.count)).toBe(1);
    });
  });
}
