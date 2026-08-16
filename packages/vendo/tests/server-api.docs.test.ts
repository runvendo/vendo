import { readFile } from "node:fs/promises";
import { SEATS } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { REMOVED_CONFIG_KEYS } from "../src/config-keys.js";

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
 * The restructure closed the duplication that made this file necessary:
 * server-api.mdx dropped its own `## Config keys` table and now sends the
 * reader to handler-options.mdx, which is the one gated copy. So the key-for-key
 * comparison lives on the sibling alone, and what is asserted here is that this
 * page keeps NO second copy to rot — plus the two claims that were never in a
 * table and so were never covered by one.
 */

const SERVER_API_PAGE = new URL("../../../docs-site/reference/server-api.mdx", import.meta.url);
const HANDLER_OPTIONS_PAGE = new URL(
  "../../../docs-site/reference/handler-options.mdx",
  import.meta.url,
);

describe("server-api.mdx keeps no second copy of the config keys", () => {
  it("sends the reader to the one gated page instead", async () => {
    const page = await readFile(SERVER_API_PAGE, "utf8");
    expect(page).not.toMatch(/^## Config keys$/m);
    expect(page).toContain("/reference/handler-options");
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

/** The `## `models`` section of handler-options.mdx: one row per seat, the seat
 *  name in the first cell. The restructure moved the vocabulary out of an inline
 *  `{ … }` group on the `models` option row and into this table, and moved it
 *  off server-api.mdx entirely — that page defers to this one now. */
const seatSection = (page: string): string => {
  const start = page.indexOf("## `models`");
  return page.slice(start, page.indexOf("\n## ", start + 1));
};

const documentedSeats = (section: string): string[] =>
  [...section.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((match) => match[1]!);

/**
 * The page that documents the seat vocabulary is pinned to the one closed list
 * in `@vendoai/core`. server-api.mdx invented a `verifier` seat and
 * handler-options.mdx taught the same one plus a `knowledgeVerifier` →
 * `verifier` migration — neither has ever existed on `ModelsConfig`, and the
 * knowledge verifier pass they belonged to was removed outright.
 */
describe("the reference pages pin their model seats to model-seats.ts", () => {
  it("handler-options.mdx names exactly the real seats", async () => {
    const section = seatSection(await readFile(HANDLER_OPTIONS_PAGE, "utf8"));
    expect(section, "the `models` seat table must still exist").not.toBe("");
    // Compared as a set: the table orders seats by how they relate to each
    // other, which is the page's call, while WHICH seats exist is not.
    expect(documentedSeats(section).sort()).toEqual([...SEATS].sort());
    // The set comparison covers an invented seat inside the TABLE; this covers
    // one named in the section's prose, which is where the "`knowledgeVerifier`
    // → `verifier`" migration claim sat. Scoped to the seat SPELLING rather than
    // the word, so the page can still say the old slot is gone — which it
    // should, and which the house style does for every other removed key.
    expect(section).not.toMatch(/`(models\.)?verifier`/i);
  });

  it("server-api.mdx teaches no seat vocabulary of its own to rot", async () => {
    const page = await readFile(SERVER_API_PAGE, "utf8");
    expect(page).not.toMatch(/`(models\.)?verifier`/i);
    expect(page).not.toMatch(/^## `models`$/m);
  });
});
