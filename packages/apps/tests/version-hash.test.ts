import {
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { appVersionHash } from "../src/server/index.js";

const document = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_original",
  name: "Maple snapshot",
  ui: "tree",
  ...overrides,
});

describe("appVersionHash", () => {
  it("hashes canonical app content without copy identity or lineage", () => {
    const original = document({ forkedFrom: "app_template" });
    const reordered = {
      ui: original.ui,
      name: original.name,
      id: "app_imported_copy",
      format: original.format,
    } as AppDocument;

    expect(appVersionHash(original)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(appVersionHash(reordered)).toBe(appVersionHash(original));
    expect(appVersionHash({ ...original, id: "app_other", forkedFrom: "app_other_source" }))
      .toBe(appVersionHash(original));
    expect(appVersionHash({ ...original, name: "Changed content" }))
      .not.toBe(appVersionHash(original));
  });
});
