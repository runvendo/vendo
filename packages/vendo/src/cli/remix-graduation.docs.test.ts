import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Graduation gate (2026-08-03): remix shipped — the frozen eval scored the
 * redesigned journey and the label came off. No shipping doc may call remix
 * experimental again without deliberately deleting this test. The docs live
 * in this repo, so this is a plain test against the doc sources — it runs in
 * the normal `pnpm test` suite (same pattern as doctor-codes.docs.test.ts).
 */

const REPO_ROOT = new URL("../../../../", import.meta.url);

/** The remix-dedicated pages: nothing on them is experimental anymore. */
const REMIX_PAGES = [
  "docs-site/connect/host-components.mdx",
  "docs/host-components.md",
];

/** Pages that mention remix among other features: the word "experimental"
 *  may appear (machines, served apps), but never on a line about remix. */
const MIXED_PAGES = [
  "docs-site/reference/cli.mdx",
  "docs-site/reference/dot-vendo.mdx",
  "docs/quickstart.md",
  "README.md",
];

describe("remix is a shipped capability, not an experiment", () => {
  it("keeps the remix-dedicated pages free of 'experimental'", async () => {
    for (const page of REMIX_PAGES) {
      const text = await readFile(new URL(page, REPO_ROOT), "utf8");
      expect(text, `${page} may not call remix experimental`).not.toMatch(/experimental/i);
    }
  });

  it("never pairs remix with 'experimental' on mixed pages", async () => {
    for (const page of MIXED_PAGES) {
      const lines = (await readFile(new URL(page, REPO_ROOT), "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (/remix/i.test(line)) {
          expect(line, `${page}:${index + 1} may not call remix experimental`).not.toMatch(/experimental/i);
        }
      }
    }
  });
});
