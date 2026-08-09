import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CREATE_VENDO_CONFIG_KEYS, docsTableDiff, tableKeys } from "../src/config-keys.js";

/**
 * Docs-rot gate: the composition configuration table on handler-options.mdx must
 * list exactly the top-level keys of `CreateVendoConfig`.
 *
 * THE GATE THAT WASN'T. This file used to carry its own copy of the key list plus
 * an `AssertNever` that was supposed to fail compilation when the interface grew
 * a key. `packages/vendo/tsconfig.json` excludes `src/**\/*.test.ts` from
 * typecheck, so nothing ever compiled that assertion — the list sat ten keys
 * behind the interface and this test passed the whole time, because it was
 * comparing the docs against a stale list rather than against the type.
 *
 * The list now lives in `./config-keys.ts`, inside the typecheck include, where
 * both directions of the assertion are real (proven red: removing a key from the
 * list errors `Type '"automations"' does not satisfy the constraint 'never'`; adding an
 * invented one errors `Type '"notAKey"' is not assignable to keyof
 * CreateVendoConfig`). This file is the RUNTIME half.
 */

const OPTIONS_PAGE = new URL("../../../docs-site/reference/handler-options.mdx", import.meta.url);
const MIGRATION_TABLE = new URL(
  "../../../docs/config-migration-table.md",
  import.meta.url,
);

const compositionTable = (page: string): string => {
  const start = page.indexOf("## Composition configuration");
  return page.slice(start, page.indexOf("##", start + 1));
};

describe("handler-options.mdx stays 1:1 with CreateVendoConfig", () => {
  it("documents every config key and no key that does not exist", async () => {
    const table = compositionTable(await readFile(OPTIONS_PAGE, "utf8"));
    expect(docsTableDiff(tableKeys(table))).toEqual({ missing: [], unknown: [], duplicated: [] });
  });
});

describe("the §10 migration table states a destination for every key", () => {
  it("covers all of them, and invents none", async () => {
    const table = await readFile(MIGRATION_TABLE, "utf8");
    expect(docsTableDiff(tableKeys(table))).toEqual({ missing: [], unknown: [], duplicated: [] });
  });
});

/**
 * The gate proving the gate. A docs-rot check that reads the wrong thing looks
 * exactly like one that finds nothing wrong, and this file shipped in that state
 * for ten keys — so the comparison is driven against synthetic pages here, where
 * each failure mode can actually be produced.
 */
describe("the gate can still FAIL", () => {
  const row = (key: string): string => `| \`${key}\` | what it does |`;
  const pageOf = (keys: readonly string[]): string =>
    ["## Composition configuration", "", "| Option | Behavior |", "| --- | --- |", ...keys.map(row), "", "## Next"].join("\n");

  it("catches a key the docs forgot", () => {
    const documented = CREATE_VENDO_CONFIG_KEYS.filter((key) => key !== "automations");
    const diff = docsTableDiff(tableKeys(compositionTable(pageOf(documented))));
    expect(diff.missing).toEqual(["automations"]);
  });

  it("catches a key the docs invented", () => {
    const documented = [...CREATE_VENDO_CONFIG_KEYS, "gadgets"];
    const diff = docsTableDiff(tableKeys(compositionTable(pageOf(documented))));
    expect(diff.unknown).toEqual(["gadgets"]);
  });

  it("catches a key documented twice", () => {
    const documented = [...CREATE_VENDO_CONFIG_KEYS, "store"];
    const diff = docsTableDiff(tableKeys(compositionTable(pageOf(documented))));
    expect(diff.duplicated).toEqual(["store"]);
  });

  it("reads the table, not the whole page — a key mentioned in prose is not documentation", () => {
    const page = [
      "## Composition configuration",
      "",
      "| Option | Behavior |",
      "| --- | --- |",
      ...CREATE_VENDO_CONFIG_KEYS.filter((key) => key !== "automations").map(row),
      "",
      "## Automations",
      "",
      `| \`automations\` | documented in the WRONG section |`,
    ].join("\n");
    expect(docsTableDiff(tableKeys(compositionTable(page))).missing).toEqual(["automations"]);
  });
});
