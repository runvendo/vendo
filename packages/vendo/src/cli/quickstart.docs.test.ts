import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { routeSource } from "./init-scaffolds.js";

/**
 * Quickstart drift gate. `docs/quickstart.md` is the first code a host ever
 * pastes, and it rotted four ways at once (a `@vendoai/core` import no host can
 * resolve under pnpm strict linking, a deprecated `model:` pin as the primary
 * example, a config listing missing keys its own prose referenced, and an intro
 * describing an init that no longer exists). Prose can't be tested; the
 * load-bearing lines can:
 *
 *   1. the three generated files' code blocks vs the `init-scaffolds.ts`
 *      exports that actually write them,
 *   2. the config listing vs `quickstart-config-surface.docs-check.ts`, byte for
 *      byte — that file holds the same block and is compiled against the real
 *      `CreateVendoConfig`/`Vendo` (nested shapes and optionality included), so
 *      the types and the imports are checked by `pnpm typecheck` rather than by
 *      a list maintained here,
 *   3. the listing's top-level key set and @deprecated marks vs `types.ts` —
 *      a readable failure for the most common drift, and the one thing types
 *      cannot carry,
 *   4. every `@vendoai/*` import specifier in a code block resolvable from a
 *      host's own node_modules (never a transitive package),
 *   5. no deprecated `model:` / `paint:` pin in the composition examples.
 *
 * NOTE: `tsconfig.json` excludes `*.test.ts`, so nothing in THIS file is
 * typechecked. Every compile-time guarantee lives in the fixture instead, under
 * its own `tsconfig.docs-check.json` — typechecked, never emitted.
 */

const QUICKSTART = new URL("../../../../docs/quickstart.md", import.meta.url);
const TYPES_SOURCE = new URL("../types.ts", import.meta.url);
const CONFIG_FIXTURE = new URL("./quickstart-config-surface.docs-check.ts", import.meta.url);

/** The fixture's copy of the doc block, between its markers. */
const FIXTURE_REGION = /^\/\/ --- BEGIN docs\/quickstart\.md config surface ---\n([\s\S]*?)^\/\/ --- END docs\/quickstart\.md config surface ---$/m;

/** The only difference the fixture is allowed: a package cannot resolve itself
 *  by name, so the doc's host-facing specifiers become the local entries.
 *
 *  Anchored to an import declaration's own closing line, not matched loosely:
 *  a `from "@vendoai/vendo";` quoted inside a COMMENT must not be able to
 *  absorb the rewrite while the real import already reads `from "../index.js";`
 *  — byte identity and the host-installability check would both then pass over
 *  host code that cannot resolve. */
const LOCAL_ENTRIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\} from "@vendoai\/vendo\/server";$/gm, '} from "../server.js";'],
  [/^\} from "@vendoai\/vendo";$/gm, '} from "../index.js";'],
];

/** Import declarations only — `from "x"` at the end of a line that is not a
 *  comment, so a specifier quoted in prose is never mistaken for one a host
 *  pastes. */
function importSpecifiers(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .flatMap((line) => [...line.matchAll(/\bfrom ["']([^"']+)["'];?\s*$/g)].map((match) => match[1]!));
}

/** The packages a host installs directly (09-vendo §1): the umbrella, its
 *  subpaths, the UI package, and the `vendoai` alias. Anything else in a
 *  quickstart code block is a transitive dependency the reader cannot import. */
const HOST_INSTALLABLE = /^(?:@vendoai\/(?:vendo|ui)|vendoai)(?:\/[\w./-]+)?$/;

/** Every fenced block's body. */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
}

/** The block whose first line is the `// <path>` marker the doc labels it with. */
function blockFor(blocks: string[], marker: string): string {
  const found = blocks.filter((block) => block.startsWith(`// ${marker}`));
  expect(found.length, `expected exactly one code block starting with "// ${marker}"`).toBe(1);
  return found[0]!;
}

/** The one block declaring the config surface. */
function configListing(blocks: string[]): string {
  const found = blocks.filter((block) => block.includes("export interface CreateVendoConfig {"));
  expect(found.length, "expected exactly one config-surface code block").toBe(1);
  return found[0]!;
}

/** Load-bearing lines: code only, comments and blank lines dropped. */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*\/\/.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "" && !/^\s*(?:\/\*|\*)/.test(line));
}

/** An interface declaration's body — through the closing `}` in column 0. Both
 *  sources are 2-space formatted, so nothing but the terminator sits there. */
function interfaceBody(source: string, name: string): string {
  const declaration = source.indexOf(`interface ${name} {`);
  expect(declaration, `interface ${name} not found`).toBeGreaterThanOrEqual(0);
  return source.slice(declaration).split(/^\}$/m)[0]!;
}

/** The interface's own members, in declaration order. Indentation is the depth
 *  signal: a nested member sits deeper than two spaces. */
function interfaceMembers(source: string, name: string): string[] {
  return [...interfaceBody(source, name).matchAll(/^ {2}(\w+)\??\s*[:(]/gm)].map((match) => match[1]!);
}

/** The members whose own comment says @deprecated — the one fact the compiled
 *  fixture's type identity cannot carry. */
function deprecatedMembers(source: string, name: string): string[] {
  const pattern = /@deprecated[\s\S]*?\*\/\s+(\w+)\??\s*[:(]/g;
  return [...interfaceBody(source, name).matchAll(pattern)].map((match) => match[1]!);
}

const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));

describe("docs/quickstart.md stays 1:1 with the surfaces it documents", () => {
  it("shows the route scaffold verbatim as the primary composition", () => {
    const documented = blockFor(blocks, "app/api/vendo/[...vendo]/route.ts");
    const scaffold = routeSource({
      serverActions: false,
      auth: { preset: "authJs", dependency: "next-auth" },
    });
    expect(codeLines(documented)).toEqual(codeLines(scaffold));
  });

  it("never tells a host to import a transitive package", () => {
    for (const block of blocks) {
      // Import declarations only: a specifier quoted inside a comment is prose,
      // and must not be able to stand in for the one a host actually pastes.
      for (const specifier of importSpecifiers(block)) {
        if (!specifier.startsWith("@vendoai/") && !specifier.startsWith("vendoai")) continue;
        expect(HOST_INSTALLABLE.test(specifier), `${specifier} is not installable by a host`).toBe(true);
      }
    }
  });

  it("pins no deprecated model in the composition examples", () => {
    // Every ts/tsx block that composes: the deprecated top-level `model:` and
    // `paint:` keys must never appear as the example a reader copies.
    const compositions = blocks.filter((block) => block.includes("createVendo({"));
    expect(compositions.length).toBeGreaterThan(0);
    for (const block of compositions) {
      for (const line of codeLines(block)) {
        expect(/^\s*(?:model|paint)\s*:/.test(line), `deprecated pin in a composition example: ${line}`).toBe(false);
      }
    }
  });

  it("keeps the config listing byte-identical to the compiled fixture", async () => {
    const listing = configListing(blocks);
    const fixture = await readFile(CONFIG_FIXTURE, "utf8");
    const region = FIXTURE_REGION.exec(fixture)?.[1];
    expect(region, "the fixture lost its BEGIN/END markers").toBeDefined();

    const localized = LOCAL_ENTRIES.reduce(
      (source, [declaration, local]) => source.replace(declaration, local),
      listing,
    );
    // Byte equality is the point: the fixture is what `pnpm typecheck` compiles
    // against the real types, so anything the doc says that the fixture doesn't
    // is unverified. Re-derive the fixture from the doc block, never by hand.
    // It also proves the rewrite hit real import declarations — a doc that
    // stopped naming the public specifiers no longer matches the fixture.
    expect(region).toBe(localized);
    // Nothing in the listing may import from a relative path: that is the
    // fixture's private rewrite, never something a host could paste.
    for (const specifier of importSpecifiers(listing)) {
      expect(specifier.startsWith("."), `relative import in the doc: ${specifier}`).toBe(false);
    }
  });

  it("lists exactly the documented interfaces' members, deprecations included", async () => {
    const listing = configListing(blocks);
    const source = await readFile(TYPES_SOURCE, "utf8");
    for (const name of ["CreateVendoConfig", "Vendo"]) {
      expect(interfaceMembers(listing, name), name).toEqual(interfaceMembers(source, name));
    }
    expect(deprecatedMembers(listing, "CreateVendoConfig"))
      .toEqual(deprecatedMembers(source, "CreateVendoConfig"));
  });
});
