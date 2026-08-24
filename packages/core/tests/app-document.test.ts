import { describe, expect, it } from "vitest";
import { appBundleSchema, appDocumentSchema } from "../src/app-document.js";
import { VENDO_APP_FORMAT } from "../src/formats.js";

const hex = "a".repeat(64);
const bundle = {
  entry: hex,
  assets: { "chunk.js": "b".repeat(64) },
  bytes: 4096,
  sealedAt: "2026-08-24T16:00:00.000Z",
};
const app = { format: VENDO_APP_FORMAT, id: "app_a", name: "A" };

describe("appBundleSchema", () => {
  it("accepts a hash-keyed seal and passes unknown keys through", () => {
    expect(appBundleSchema.parse({ ...bundle, future: true })).toMatchObject({ entry: hex, future: true });
  });

  // Every key of a seal is content-addressed. A path here would name a blob no
  // seal ever wrote, and blobs are immutable, so the miss is unrecoverable.
  it("refuses a path where a content hash belongs", () => {
    expect(appBundleSchema.safeParse({ ...bundle, entry: "dist/app.js" }).success).toBe(false);
    expect(appBundleSchema.safeParse({ ...bundle, assets: { "chunk.js": "dist/chunk.js" } }).success).toBe(false);
  });
});

describe("appDocumentSchema", () => {
  it("accepts a sealed bundle app and refuses a malformed seal", () => {
    expect(appDocumentSchema.safeParse({ ...app, ui: "bundle", bundle }).success).toBe(true);
    expect(appDocumentSchema.safeParse({ ...app, ui: "bundle", bundle: { ...bundle, entry: "dist/app.js" } }).success)
      .toBe(false);
  });

  it("accepts a build awaiting consent and refuses one with no approval to answer", () => {
    const proposal = { approvalId: "apr_1", prompt: "a budget tracker", why: "needs a chart library", at: bundle.sealedAt };
    expect(appDocumentSchema.safeParse({ ...app, proposal }).success).toBe(true);
    expect(appDocumentSchema.safeParse({ ...app, proposal: { ...proposal, approvalId: "" } }).success).toBe(false);
  });
});
