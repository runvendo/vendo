/**
 * The one door in.
 *
 * Every app write that MINTS OR CHANGES a document reaches the store through
 * `appRecordInput`, the row writer, and `appRecordInput` is the only caller of
 * `admitAppDocument` in the codebase.
 *
 * There is no longer any exception: an automation is a record of its own, so
 * `@vendoai/automations` writes no app rows at all and nothing reaches this
 * collection past admission.
 *
 * This suite drives EVERY origin in `AdmissionOrigin` through the real path — a
 * real `RecordStore`, no stub between the writer and the row — and asserts
 * three things:
 *
 *  1. an invalid document is REFUSED on every origin,
 *  2. the refusal says the SAME thing on every origin (a door that checked
 *     differently per caller would not be one door), and
 *  3. nothing lands in the store when a document is refused, and
 *  4. a stored `tree` — layout from before an app was its own `app.tsx` — is
 *     dropped on the way in rather than refused, so a document older than the
 *     field's removal still opens on its source.
 *
 * The removal proof this file exists for: comment out the `admitAppDocument`
 * call in `persistence.ts`'s row writer and every origin's refusal goes red at
 * once, not one of them.
 */
import { VendoError, type RecordStore } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  admitAppDocument,
  validateAppDocument,
  type AdmissionOrigin,
  type AppDocument,
} from "../src/contract/index.js";
import { appRecordInput, rowFromRecord } from "../src/server/persistence/persistence.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { screenDocument } from "../src/server/testing/screen-document.js";

/** Every origin the contract declares. A new one must be added here, and the
 *  door must treat it exactly like the others. */
const ORIGINS: readonly AdmissionOrigin[] = [
  "screen-agent",
  "box",
  "seed",
  "mcp",
  "automation",
  "console",
  "import",
];

const SUBJECT = "user_1";

const valid = (id: string): AppDocument => screenDocument(id, { name: "Renewals" });

/** Refused for a CROSS-FIELD reason, not a schema typo: an island tool manifest
 *  naming a component the document does not carry. Only the normative validator
 *  catches this — `appDocumentSchema` alone accepts it — so a door that skipped
 *  admission would let it through. */
const invalid = (id: string): AppDocument =>
  screenDocument(id, { name: "Renewals", componentTools: { Missing: ["host_read"] } });

const apps = (): RecordStore => memoryStore().records("vendo_apps");

const refusalOf = async (
  records: RecordStore,
  document: AppDocument,
  origin: AdmissionOrigin,
): Promise<VendoError> => {
  try {
    await records.put(appRecordInput(document, SUBJECT, false, origin));
  } catch (error) {
    if (error instanceof VendoError) return error;
    throw error;
  }
  throw new Error(`origin ${origin} admitted a document the door must refuse`);
};

describe("the one door in", () => {
  it.each(ORIGINS)("refuses an invalid document written as %s", async (origin) => {
    const records = apps();
    const error = await refusalOf(records, invalid("app_bad"), origin);

    expect(error.code).toBe("validation");
    expect(error.message).toBe("invalid app document for app_bad");
    // The origin is RECORDED — and it is the only thing about the refusal that
    // varies with who wrote it.
    expect((error.detail as { origin?: string }).origin).toBe(origin);
    // Nothing landed. A refused write is not a partial write.
    expect(await records.get("app_bad")).toBeNull();
  });

  it("gives the SAME findings for the same document on every origin", async () => {
    const reasons = new Map<AdmissionOrigin, string>();
    for (const origin of ORIGINS) {
      const error = await refusalOf(apps(), invalid("app_bad"), origin);
      reasons.set(origin, (error.detail as { reason: string }).reason);
    }

    const distinct = new Set(reasons.values());
    expect([...distinct]).toHaveLength(1);
    expect([...distinct][0]).toContain('componentTools names "Missing"');
  });

  it.each(ORIGINS)("admits a valid document written as %s, byte-identically", async (origin) => {
    const records = apps();
    await records.put(appRecordInput(valid("app_ok"), SUBJECT, false, origin));

    const record = await records.get("app_ok");
    expect(record).not.toBeNull();
    expect(rowFromRecord(record!).doc).toEqual(valid("app_ok"));
  });

  it("admits or refuses identically whatever the origin claims", () => {
    for (const document of [valid("app_ok"), invalid("app_bad")]) {
      const results = ORIGINS.map((origin) => admitAppDocument({ document, origin }));
      // The origin is echoed back and nothing else about the verdict moves.
      expect(results.map((result) => result.origin)).toEqual([...ORIGINS]);
      const verdicts = results.map((result) =>
        JSON.stringify(result.ok ? { ok: true, document: result.document } : { ok: false, code: result.code, findings: result.findings }));
      expect(new Set(verdicts).size).toBe(1);
    }
  });

  it("drops a stale stored tree already in the store, and keeps the app", async () => {
    // Rows written before the `tree` field was removed still carry one. It is
    // dropped rather than refused: the app IS its `app.tsx`, so a document that
    // predates the removal still opens on its source and must not brick over a
    // field nobody reads any more.
    const records = apps();
    const stale = {
      ...valid("app_stale"),
      tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [] },
    } as AppDocument;
    // Seeded PAST `appRecordInput`, which is what such a row is: it predates the
    // writer's strip. Writing it through the writer would strip it on the way in
    // and leave the READ strip — the only half a legacy row ever meets —
    // unexercised.
    await records.put({
      id: "app_stale",
      data: { subject: SUBJECT, enabled: false, doc: stale },
      refs: { subject: SUBJECT },
    });

    // Read back through the real read path, not the object that was handed in.
    const doc = rowFromRecord((await records.get("app_stale"))!).doc;
    expect(doc).toEqual(valid("app_stale"));
    expect(doc).not.toHaveProperty("tree");
  });

  it("leaves an honest document byte-identical — the strip is not a rewrite", async () => {
    const records = apps();
    await records.put(appRecordInput(valid("app_ok"), SUBJECT, false, "screen-agent"));
    expect(rowFromRecord((await records.get("app_ok"))!).doc).toEqual(valid("app_ok"));
  });

  it("is `validateAppDocument` plus a label — the inner half stays exported", () => {
    for (const document of [valid("app_ok"), invalid("app_bad")]) {
      const inner = validateAppDocument(document);
      const admitted = admitAppDocument({ document, origin: "console" });
      expect(admitted.ok).toBe(inner.ok);
      if (!admitted.ok && !inner.ok) {
        expect(admitted.code).toBe(inner.error.code);
        expect(admitted.findings[0]?.message).toBe(inner.error.message);
      }
    }
  });

});
