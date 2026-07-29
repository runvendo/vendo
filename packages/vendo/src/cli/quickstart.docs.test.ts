import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registrySource, routeSource, vendoRootWrapperSource } from "./init-scaffolds.js";

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
 *   3. the listing's top-level key set and @deprecated marks vs `server.ts` —
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
const SERVER_SOURCE = new URL("../server.ts", import.meta.url);
const CONFIG_FIXTURE = new URL("./quickstart-config-surface.docs-check.ts", import.meta.url);

/** The fixture's copy of the doc block, between its markers. */
const FIXTURE_REGION = /^\/\/ --- BEGIN docs\/quickstart\.md config surface ---\n([\s\S]*?)^\/\/ --- END docs\/quickstart\.md config surface ---$/m;

/** The only difference the fixture is allowed: a package cannot resolve itself
 *  by name, so the doc's host-facing specifiers become the local entries.
 *
 *  Anchored to an import declaration's own closing line, not matched loosely:
 *  an unanchored replace lets a `from "@vendoai/vendo";` inside a COMMENT
 *  absorb the rewrite (String.replace takes the first hit only) while the real
 *  import already reads `from "../index.js";` — byte identity and the
 *  host-installability check would both pass over host code that cannot
 *  resolve. */
const LOCAL_ENTRIES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^\} from "@vendoai\/vendo\/server";$/gm, '} from "../server.js";', '@vendoai/vendo/server'],
  [/^\} from "@vendoai\/vendo";$/gm, '} from "../index.js";', '@vendoai/vendo'],
];

/** Import declarations only — `from "x"` at the end of a line that is not a
 *  comment. Used to assert the doc names the PUBLIC specifiers for real. */
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

interface CodeBlock {
  lang: string;
  body: string;
}

function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = /^```(\w*)\n([\s\S]*?)^```$/gm;
  for (const match of markdown.matchAll(pattern)) blocks.push({ lang: match[1]!, body: match[2]! });
  return blocks;
}

/** The block whose first line is the `// <path>` marker the doc labels it with. */
function blockFor(blocks: CodeBlock[], marker: string): string {
  const found = blocks.filter((block) => block.body.startsWith(`// ${marker}`));
  expect(found.length, `expected exactly one code block starting with "// ${marker}"`).toBe(1);
  return found[0]!.body;
}

/** The one block declaring the config surface. */
function configListing(blocks: CodeBlock[]): string {
  const found = blocks.filter((block) => block.body.includes("export interface CreateVendoConfig {"));
  expect(found.length, "expected exactly one config-surface code block").toBe(1);
  return found[0]!.body;
}

/** Load-bearing lines: code only, comments and blank lines dropped. */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*\/\/.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "" && !/^\s*(?:\/\*|\*)/.test(line));
}

/** Comments collapsed to a brace-free marker that survives the line scan, so
 *  @deprecated stays attributable without a doc comment's `{tenant}` breaking
 *  the depth count. */
function markComments(source: string): string {
  const mark = (comment: string): string => (comment.includes("@deprecated") ? "/*!*/" : "");
  return source.replace(/\/\*[\s\S]*?\*\//g, mark).replace(/\/\/[^\n]*/g, mark);
}

/** The interface's own members — depth-1 keys, in declaration order, each
 *  flagged when its comment says @deprecated. */
function interfaceMembers(source: string, name: string): Array<{ key: string; deprecated: boolean }> {
  const marked = markComments(source);
  const declaration = marked.indexOf(`interface ${name} {`);
  expect(declaration, `interface ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyStart = marked.indexOf("{", declaration) + 1;
  let depth = 1;
  let cursor = bodyStart;
  while (depth > 0) {
    const char = marked[cursor];
    expect(char, `unterminated interface ${name}`).toBeDefined();
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    cursor += 1;
  }

  const members: Array<{ key: string; deprecated: boolean }> = [];
  let nesting = 0;
  let pendingDeprecated = false;
  for (const line of marked.slice(bodyStart, cursor - 1).split("\n")) {
    if (nesting === 0) {
      const member = /^\s*(\w+)\??\s*[:(]/.exec(line);
      if (member !== null) {
        members.push({ key: member[1]!, deprecated: pendingDeprecated || line.includes("/*!*/") });
        pendingDeprecated = false;
      } else if (line.includes("/*!*/")) {
        pendingDeprecated = true;
      }
    }
    nesting += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return members;
}

describe("docs/quickstart.md stays 1:1 with the surfaces it documents", () => {
  it("shows the registry scaffold's own import, not a transitive one", async () => {
    const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));
    const documented = blockFor(blocks, "vendo/registry.tsx");
    const scaffold = registrySource("tsx");

    // The specifier is the whole point (init-scaffolds.ts: @vendoai/core is
    // transitive, so a host importing it fails to resolve with TS2307).
    const scaffoldImport = codeLines(scaffold).find((line) => line.startsWith("import type {"))!;
    expect(scaffoldImport).toBe(`import type { ComponentRegistry } from "@vendoai/vendo";`);
    expect(codeLines(documented)).toContain(scaffoldImport);
    expect(documented).toContain("satisfies ComponentRegistry");
  });

  it("shows the route scaffold verbatim as the primary composition", async () => {
    const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));
    const documented = blockFor(blocks, "app/api/vendo/[...vendo]/route.ts");
    const scaffold = routeSource({
      serverActions: false,
      auth: { preset: "authJs", dependency: "next-auth" },
      registrySpecifier: "@/vendo/registry",
    });
    expect(codeLines(documented)).toEqual(codeLines(scaffold));
  });

  it("shows the client-mount scaffold verbatim", async () => {
    const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));
    const documented = blockFor(blocks, "vendo/vendo-root.tsx");
    const scaffold = vendoRootWrapperSource({ themeSpecifier: "../.vendo/theme.json" });
    expect(codeLines(documented)).toEqual(codeLines(scaffold));
  });

  it("never tells a host to import a transitive package", async () => {
    const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));
    for (const block of blocks) {
      // Import declarations only: a specifier quoted inside a comment is prose,
      // and must not be able to stand in for the one a host actually pastes.
      for (const specifier of importSpecifiers(block.body)) {
        if (!specifier.startsWith("@vendoai/") && !specifier.startsWith("vendoai")) continue;
        expect(HOST_INSTALLABLE.test(specifier), `${specifier} is not installable by a host`).toBe(true);
      }
    }
  });

  it("pins no deprecated model in the composition examples", async () => {
    const blocks = codeBlocks(await readFile(QUICKSTART, "utf8"));
    // Every ts/tsx block that composes: the deprecated top-level `model:` and
    // `paint:` keys must never appear as the example a reader copies.
    const compositions = blocks.filter((block) => block.body.includes("createVendo({"));
    expect(compositions.length).toBeGreaterThan(0);
    for (const block of compositions) {
      for (const line of codeLines(block.body)) {
        expect(/^\s*(?:model|paint)\s*:/.test(line), `deprecated pin in a composition example: ${line}`).toBe(false);
      }
    }
  });

  it("keeps the config listing byte-identical to the compiled fixture", async () => {
    const listing = configListing(codeBlocks(await readFile(QUICKSTART, "utf8")));
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
    expect(region).toBe(localized);
    // And the rewrite must have applied to real import declarations — a doc
    // that stopped naming the public specifiers, or hid one in a comment,
    // would otherwise match a stale fixture.
    const specifiers = importSpecifiers(listing);
    for (const [, , published] of LOCAL_ENTRIES) {
      expect(specifiers, `the listing must import from ${published}`).toContain(published);
    }
    // Nothing in the listing may import from a relative path: that is the
    // fixture's private rewrite, never something a host could paste.
    for (const specifier of specifiers) {
      expect(specifier.startsWith("."), `relative import in the doc: ${specifier}`).toBe(false);
    }
  });

  it("lists exactly createVendo's config keys, deprecations included", async () => {
    const listing = configListing(codeBlocks(await readFile(QUICKSTART, "utf8")));
    const source = await readFile(SERVER_SOURCE, "utf8");
    expect(interfaceMembers(listing, "CreateVendoConfig"))
      .toEqual(interfaceMembers(source, "CreateVendoConfig"));
  });

  it("lists exactly the Vendo interface's members", async () => {
    const listing = configListing(codeBlocks(await readFile(QUICKSTART, "utf8")));
    const source = await readFile(SERVER_SOURCE, "utf8");
    expect(interfaceMembers(listing, "Vendo")).toEqual(interfaceMembers(source, "Vendo"));
  });
});
