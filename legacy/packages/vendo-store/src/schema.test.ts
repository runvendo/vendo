import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createVendoDatabase, migrateVendoDatabase } from "./db.js";
import { automations, threadMessages } from "./schema.js";

let suffix = 0;

/** Unique memory:// dataDir per test so the process-wide registry never collides. */
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://schema-test-${Date.now()}-${suffix}`;
}

describe("vendo schema migration", () => {
  it("migrates a fresh PGlite db and round-trips a row in automations and thread_messages", async () => {
    const handle = await createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } });
    await migrateVendoDatabase(handle);

    const now = new Date().toISOString();
    await handle.db.insert(automations).values({
      id: "auto_1",
      tenantId: "tenant_1",
      subject: "subject_1",
      name: "Test Automation",
      status: "active",
      spec: { steps: [] },
      currentVersion: 1,
      triggerKind: "manual",
      counters: { runs: 0 },
      createdAt: now,
      updatedAt: now,
    });

    const automationRows = await handle.db.select().from(automations).where(eq(automations.id, "auto_1"));
    expect(automationRows).toHaveLength(1);
    expect(automationRows[0]).toMatchObject({
      id: "auto_1",
      tenantId: "tenant_1",
      subject: "subject_1",
      name: "Test Automation",
      status: "active",
      currentVersion: 1,
      triggerKind: "manual",
    });

    await handle.db.insert(threadMessages).values({
      tenantId: "tenant_1",
      subject: "subject_1",
      threadId: "thread_1",
      messageId: "msg_1",
      seq: 0,
      message: { role: "user", content: "hi" },
    });

    const messageRows = await handle.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.messageId, "msg_1"));
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]).toMatchObject({
      tenantId: "tenant_1",
      subject: "subject_1",
      threadId: "thread_1",
      messageId: "msg_1",
      seq: 0,
    });
    // bigserial primary key exercised
    expect(typeof messageRows[0]?.rowId).toBe("number");
  });
});
