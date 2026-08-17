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
 *  4. a document that is VALID but carries forged server-authoritative claims
 *     is sanitised on the way in, on every origin.
 *
 * The removal proof this file exists for: comment out the `admitAppDocument`
 * call in `persistence.ts`'s row writer and every origin's refusal goes red at
 * once, not one of them.
 */
import { VENDO_APP_FORMAT, VendoError, type RecordStore } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  admitAppDocument,
  validateAppDocument,
  type AdmissionOrigin,
  type AppDocument,
} from "../src/contract/index.js";
import { appRecordInput, rowFromRecord } from "../src/server/persistence/persistence.js";
import { memoryStore } from "../src/server/testing/memory-store.js";

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

const valid = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Renewals",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Renewals" } }],
  },
} as AppDocument);

/**
 * A document that is perfectly VALID and still lies: it claims the in-client
 * venue granted it, claims a drifted pin, claims its data failed to load, and
 * smuggles a CDN package URL into a furnishing. Every one of those is
 * server-authoritative — only code that verified the hash, compared the
 * baseline or ran the queries may assert them.
 */
const forged = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Forged",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "hi" } }],
    inClient: {
      granted: true,
      versionHash: "sha256:deadbeef",
      approvedBy: "attacker",
      at: "2026-01-01T00:00:00.000Z",
    },
    pinDrift: [{ slot: "s", component: "C", baseHash: "sha256:x", reason: "baseline-changed" }],
    dataUnavailable: true,
    furnishings: { Forged: { packages: { evil: "https://evil.example/x.js" } } },
  },
} as unknown as AppDocument);

/** Refused for a CROSS-FIELD reason, not a schema typo: a generated node with
 *  no entry in the components map. Only the normative validator catches this —
 *  `appDocumentSchema` alone accepts it — so a door that skipped admission
 *  would let it through. */
const invalid = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Renewals",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Missing", source: "generated" }],
  },
} as unknown as AppDocument);

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
    expect([...distinct][0]).toContain('references generated component "Missing"');
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

  it.each(ORIGINS)("strips forged server-authoritative claims written as %s", async (origin) => {
    const records = apps();
    await records.put(appRecordInput(forged("app_forged"), SUBJECT, false, origin));

    // Read back through the real read path, not the object that was handed in.
    const tree = rowFromRecord((await records.get("app_forged"))!).doc.tree as Record<string, unknown>;
    expect(tree["inClient"]).toBeUndefined();
    expect(tree["pinDrift"]).toBeUndefined();
    expect(tree["dataUnavailable"]).toBeUndefined();
    // The furnishing itself survives; only the CDN package claim inside it dies.
    expect(tree["furnishings"]).toEqual({ Forged: {} });
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
