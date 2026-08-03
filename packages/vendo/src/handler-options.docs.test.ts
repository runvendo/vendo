import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "./handler-options.docs-check.js";

/**
 * Docs-rot gate (same pattern as doctor-codes.docs.test.ts): the composition
 * configuration table on handler-options.mdx must list exactly the top-level
 * keys of CreateVendoConfig.
 *
 * The list lives in `handler-options.docs-check.ts`, which IS typechecked
 * (tsconfig.docs-check.json), so it can neither name a key that does not exist
 * nor miss a new one. This test is the other half: the page's rows are exactly
 * that list.
 */

const OPTIONS_PAGE = new URL("../../../docs-site/reference/handler-options.mdx", import.meta.url);

/** A composition-table row: `| \`key\` | ... |`. */
const OPTION_ROW = /^\|\s*`([A-Za-z]+)`\s*\|/gm;

describe("handler-options.mdx stays 1:1 with CreateVendoConfig", () => {
  it("documents every config key and no key that does not exist", async () => {
    const page = await readFile(OPTIONS_PAGE, "utf8");
    const table = page.slice(
      page.indexOf("## Composition configuration"),
      page.indexOf("##", page.indexOf("## Composition configuration") + 1),
    );

    const documented = [...table.matchAll(OPTION_ROW)].map((match) => match[1]!);
    expect(new Set(documented).size, "duplicate rows").toBe(documented.length);
    expect(documented.sort()).toEqual([...CONFIG_KEYS].sort());
  });
});
