import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registrySource, routeSource, vendoRootWrapperSource } from "./init-scaffolds.js";
// The quickstart's config-surface import block, compiled here: every type the
// doc tells a host to import must really live on the umbrella's own entries, so
// a rename or a removed re-export breaks `pnpm typecheck` instead of the reader.
import type {
  ActAs, ActionsRegistry, AppsRuntime, AutomationsEngine, CatalogFile,
  ComponentCatalog, ComponentRegistry, Connector, ExtractedTool,
  HostOAuthAdapter, Json, Judge, KnowledgeAdapter, OverridesFile, PolicyConfig,
  PolicyFile, Principal, RunId, SandboxAdapter, SecretsProvider, ToolRegistry,
  VendoAgent, VendoGuard, VendoStore, VendoTheme,
} from "../index.js";
import type { ConnectionsService, HostAuthPreset, ModelsConfig } from "../server.js";

/**
 * Quickstart drift gate. `docs/quickstart.md` is the first code a host ever
 * pastes, and it rotted three ways at once (a `@vendoai/core` import no host
 * can resolve under pnpm strict linking, a deprecated `model:` pin as the
 * primary example, and a config listing missing keys its own prose referenced).
 * Prose can't be tested; the load-bearing lines can:
 *
 *   1. the three generated files' code blocks vs the `init-scaffolds.ts`
 *      exports that actually write them,
 *   2. the config listing's key set vs `CreateVendoConfig`/`Vendo` in
 *      `server.ts`, including which keys are marked @deprecated,
 *   3. every `@vendoai/*` import specifier in a code block resolvable from a
 *      host's own node_modules (never a transitive package),
 *   4. no deprecated `model:` / `paint:` pin in the composition examples.
 */

const QUICKSTART = new URL("../../../../docs/quickstart.md", import.meta.url);
const SERVER_SOURCE = new URL("../server.ts", import.meta.url);

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
      for (const match of block.body.matchAll(/\bfrom ["']([^"']+)["']/g)) {
        const specifier = match[1]!;
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

/** Referencing every imported type keeps the compiled import block honest —
 *  an unused type-only import is not an error, so it must be used. */
export type QuickstartConfigSurface = {
  actAs: ActAs;
  actions: ActionsRegistry;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  catalogFile: CatalogFile;
  catalog: ComponentCatalog | ComponentRegistry;
  connectors: Connector[];
  connections: ConnectionsService;
  tools: ExtractedTool[];
  oauth: HostOAuthAdapter;
  auth: HostAuthPreset;
  payload: Json;
  judge: Judge;
  knowledge: KnowledgeAdapter;
  models: ModelsConfig;
  overrides: OverridesFile;
  policy: PolicyConfig;
  policyFile: PolicyFile;
  principal: Principal;
  runs: RunId[];
  sandbox: SandboxAdapter;
  secrets: SecretsProvider;
  guardedTools: ToolRegistry;
  agent: VendoAgent;
  guard: VendoGuard;
  store: VendoStore;
  theme: VendoTheme;
};
