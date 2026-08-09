import { readFile } from "node:fs/promises";
import { SEATS } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { REMOVED_CONFIG_KEYS, docsTableDiff, tableKeys } from "../src/config-keys.js";

/**
 * Docs-rot gate for `docs-site/reference/server-api.mdx` — the sibling of the
 * one in `handler-options.docs.test.ts`, and here for the reason that page
 * survived and this one did not.
 *
 * handler-options.mdx has been gated key-for-key since the list moved into
 * `config-keys.ts`; server-api.mdx had only the compile check on its import
 * block (`server-api-imports.docs-check.ts`), which proves the type NAMES
 * resolve and says nothing about the config keys around them. It rotted exactly
 * that far (#932): the published page documented `policy`, `judge`, `approvals`
 * and the whole `agent: { … }` knobs object — four things that THROW at boot —
 * plus a `verifier` model seat that has never existed, while omitting eight real
 * keys. A host following it got an immediate crash.
 *
 * Same three failure modes, same shared comparison (`tableKeys` +
 * `docsTableDiff`), same path resolution: a URL relative to this module, so the
 * gate reads the page that publishes rather than a copy of it. The synthetic
 * red-green proof for the comparison itself lives once, in the sibling's "the
 * gate can still FAIL" block.
 */

const SERVER_API_PAGE = new URL("../../../docs-site/reference/server-api.mdx", import.meta.url);
const HANDLER_OPTIONS_PAGE = new URL(
  "../../../docs-site/reference/handler-options.mdx",
  import.meta.url,
);

/** The `## Config keys` section only: a key named in prose or in an example is
 *  not documentation, the same rule the sibling's section slice enforces. */
const configKeyTable = (page: string): string => {
  const start = page.indexOf("## Config keys");
  return page.slice(start, page.indexOf("\n## ", start + 1));
};

describe("server-api.mdx stays 1:1 with CreateVendoConfig", () => {
  it("documents every config key and no key that does not exist", async () => {
    const table = configKeyTable(await readFile(SERVER_API_PAGE, "utf8"));
    expect(docsTableDiff(tableKeys(table))).toEqual({ missing: [], unknown: [], duplicated: [] });
  });

  it("shows no removed key, and no `agent:` knobs object, as a config field", async () => {
    const page = await readFile(SERVER_API_PAGE, "utf8");
    // A removed key spelled as an optional FIELD (`policy?: PolicyConfig`) in a
    // signature is the same lie as a table row, and the table gate cannot see
    // it. The `?` is what makes this precise rather than a word ban: the words
    // themselves stay legal, because `guard({ policy, judge, approvals })` is
    // the idiom that replaced them.
    const asField = new RegExp(`^\\s*(${Object.keys(REMOVED_CONFIG_KEYS).join("|")})\\?:`, "m");
    expect(page).not.toMatch(asField);
    // `agent:` survives as the composed-agent slot; the knobs OBJECT is what
    // #861 deleted, because it configured the thinker through a key the thinker
    // never saw.
    expect(page).not.toMatch(/agent\?:\s*\{/);
  });
});

/** The `models` row of a reference page's option table — where both pages teach
 *  the seats. */
const modelsRow = (page: string): string | undefined =>
  page.split("\n").find((line) => line.startsWith("| `models` |"));

/** The seats that row teaches: the identifiers in its `{ … }` group. Both pages
 *  spell the list that way, so one comparison against `SEATS` covers both. */
const documentedSeats = (row: string | undefined): string[] | undefined =>
  row
    ?.match(/\{([^}]*)\}/)?.[1]
    ?.split(",")
    .map((seat) => seat.trim().replace(/[`?]/g, ""))
    .filter((seat) => seat.length > 0);

/**
 * Both reference pages document the seat vocabulary, so both are pinned to the
 * one closed list in `@vendoai/core`. server-api.mdx invented a `verifier` seat
 * and handler-options.mdx taught the same one plus a `knowledgeVerifier` →
 * `verifier` migration — neither has ever existed on `ModelsConfig`, and the
 * knowledge verifier pass they belonged to was removed outright.
 */
describe("the reference pages pin their model seats to model-seats.ts", () => {
  it.each([
    ["server-api.mdx", SERVER_API_PAGE],
    ["handler-options.mdx", HANDLER_OPTIONS_PAGE],
  ])("%s names exactly the real seats, in order", async (_name, url) => {
    const row = modelsRow(await readFile(url, "utf8"));
    expect(row).toBeDefined();
    expect(documentedSeats(row)).toEqual([...SEATS]);
    // The set comparison covers an invented seat inside the LIST; this covers
    // one named in the row's prose, which is where the "`knowledgeVerifier` →
    // `verifier`" migration claim sat. Scoped to the seat SPELLING rather than
    // the word, so the page can still say the old slot is gone — which it
    // should, and which the house style does for every other removed key.
    expect(row).not.toMatch(/`(models\.)?verifier`/i);
  });
});
