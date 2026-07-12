import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      await made.sql("CREATE TABLE invoices(id text primary key, total int)");
      await made.sql("INSERT INTO invoices(id, total) VALUES ('inv_1', 100), ('inv_2', 250), ('inv_3', 999)");
    });
    afterAll(async () => {
      if (made) {
        await made.sql("DROP TABLE IF EXISTS invoices");
        await made.cleanup();
      }
    });

    it("joins host rows to app records through refs containment", async () => {
      const expenses = made.store.records("app:app_hq:expenses");
      await expenses.put({ id: "expense_1", data: { cents: 100 }, refs: { invoice_id: "inv_1" } });
      await expenses.put({ id: "expense_2", data: { cents: 250 }, refs: { invoice_id: "inv_2" } });

      const rows = await made.sql(
        "SELECT i.id, r.data FROM invoices i JOIN vendo_records r ON r.refs @> jsonb_build_object('invoice_id', i.id) ORDER BY i.id",
      );
      expect(rows).toEqual([
        { id: "inv_1", data: { cents: 100 } },
        { id: "inv_2", data: { cents: 250 } },
      ]);
    });

    it("joins from the vendo side while scoping collection", async () => {
      await made.store.records("app:app_other:expenses").put({
        id: "other_expense",
        data: { cents: 999 },
        refs: { invoice_id: "inv_3" },
      });
      const rows = await made.sql(
        `SELECT r.id, i.total FROM vendo_records r
         JOIN invoices i ON r.refs @> jsonb_build_object('invoice_id', i.id)
         WHERE r.collection = $1 ORDER BY r.id`,
        ["app:app_hq:expenses"],
      );
      expect(rows).toEqual([
        { id: "expense_1", total: 100 },
        { id: "expense_2", total: 250 },
      ]);
    });
  });
}
