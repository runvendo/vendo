import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO story. The docs live in this repo, so this is a
 * plain test against the sources — it reads files and nothing else, no package
 * import, so it runs without a build.
 *
 * The Cloud restructure moved every page this gate watched and re-split the
 * facts across new homes, one canonical home per fact. Every claim below still
 * bites; each is now pinned on the page whose job that fact is. Move a fact
 * between pages and move its constant here.
 *
 * What it holds, and why each claim is load-bearing:
 *  1. the door-1 quickstart is published and every nav entry still resolves,
 *     with the quickstart FIRST in its group (the landing page's door card
 *     links straight at the quickstart, not at an overview hop);
 *  2. every tool name the docs put in front of a reader's model really exists
 *     in the registry the page is describing;
 *  3. `vendo_make`'s four arguments are its real schema properties on BOTH
 *     doors, and the asymmetry — that the IN-PROCESS pack carries no
 *     `vendo_apps_*` — matches pack.ts. That asymmetry is the one thing a
 *     reader can silently get wrong (an invented tool call), so it is pinned
 *     from both sides;
 *  4. the receipt really carries the fields the envelope table calls a law;
 *  5. every component the docs tell a reader to import is really exported from
 *     the entry point they name;
 *  6. every internal link, on every page in the tree, points at a page that
 *     really exists. Redirects do not count: they exist for links the world
 *     already published, and one of ours that needs one is a stale link.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

/** Door 1's on-ramp: init, one spread, one component. Also the page that lists
 *  what the in-process pack contains. */
const PAGE = "docs-site/existing-agent/quickstart.mdx";
const NAV_ENTRY = "existing-agent/quickstart";
const PACK_PAGE = PAGE;
/** The prose channels that reach the model before every turn. */
const PROMPT_PAGE = "docs-site/customize/instructions.mdx";
/** The envelope a `vendo_*` tool answers with, and the embeds that render it. */
const CONTRACT_PAGE = "docs-site/existing-agent/embeds.mdx";
/** The MCP door's own behaviour: who calls, what lists, what comes back. */
const DOOR_PAGE = "docs-site/outside-agents/how-the-door-works.mdx";
/** Opening the door: the `createVendo` keys, the broker, the token exchange. */
const DOOR_SETUP_PAGE = "docs-site/outside-agents/quickstart.mdx";
/** The paste a coding agent follows to wire Vendo into an existing repo. */
const INSTALL_PAGE = "docs-site/agents/index.mdx";
/** Where a generated view is mounted inside the host's own page. */
const SURFACE_PAGE = "docs-site/product/mount-the-surface.mdx";
const AGENT_TOOLS = "packages/apps/src/server/doors/agent-tools.ts";
const PACK = "packages/vendo/src/pack.ts";

interface NavGroup {
  group: string;
  pages: (string | NavGroup)[];
}
interface DocsJson {
  navigation: { tabs: { tab: string; groups: NavGroup[] }[] };
}

/** Every group in the nav, tabs and nested groups flattened. */
const navGroups = (docs: DocsJson): NavGroup[] => {
  const groups: NavGroup[] = [];
  const walk = (group: NavGroup): void => {
    groups.push(group);
    for (const page of group.pages) if (typeof page !== "string") walk(page);
  };
  for (const tab of docs.navigation.tabs) for (const group of tab.groups) walk(group);
  return groups;
};

/** Every page id the nav lists, in nav order. */
const navPages = (docs: DocsJson): string[] =>
  navGroups(docs).flatMap((group) =>
    group.pages.filter((page): page is string => typeof page === "string"),
  );

/** A docs.json page id resolves as `<id>.mdx` or `<id>/index.mdx`. */
const pageExists = (id: string): boolean => {
  const clean = id.replace(/^\//, "").replace(/\.md$/, "");
  if (clean === "") return existsSync(new URL("docs-site/index.mdx", REPO_ROOT));
  return (
    existsSync(new URL(`docs-site/${clean}.mdx`, REPO_ROOT)) ||
    existsSync(new URL(`docs-site/${clean}/index.mdx`, REPO_ROOT))
  );
};

/** Every published page, as a docs-site-relative path. Snippets are build-time
    includes, not pages — same rule pageLinks applies to link targets. */
const everyPage = (): string[] => {
  const root = new URL("docs-site/", REPO_ROOT).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) return entry === "snippets" ? [] : walk(path);
      return path.endsWith(".mdx") ? [path.slice(root.length)] : [];
    });
  return walk(root.replace(/\/$/, "")).sort();
};

/** Pages kept OUT of the nav on purpose. Mintlify still serves them by URL.
    The agents playbook is machine-fetched (vendo.run/agents.md); humans get
    give-it-to-your-agent instead, so the sidebar hides the raw playbook. */
const HIDDEN_PAGES = ["agents/index.mdx"];

/** Root-relative page links in an .mdx body. Assets are not pages. */
const pageLinks = (text: string): string[] =>
  [...new Set([...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((match) => match[1]!))].filter(
    (target) => !/^\/(images|logo|snippets)\//.test(target),
  );

describe("the BYO on-ramp page is published", () => {
  it("exists with Mintlify frontmatter and a short sidebar title", async () => {
    expect(existsSync(new URL(PAGE, REPO_ROOT)), `${PAGE} must exist`).toBe(true);
    const text = await read(PAGE);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^title: "/m);
    expect(text).toMatch(/^sidebarTitle: "Quickstart"$/m);
    expect(text).toMatch(/^description: "/m);
  });

  it("leads its group", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = navGroups(docs).find((entry) => entry.group === "In your existing agent");
    expect(group, "the 'In your existing agent' group must exist").toBeDefined();
    // The landing page's door card links straight at the quickstart, so the
    // quickstart is the group's first entry. Anything ahead of it reintroduces
    // the overview hop the landing page removed.
    expect(group?.pages[0]).toBe(NAV_ENTRY);
  });

  it("leaves no nav entry pointing at a file that does not exist", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    expect(navPages(docs).filter((id) => !pageExists(id))).toEqual([]);
  });

  it("lists every published page in the nav, and nothing else", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const listed = new Set(
      navPages(docs).map((id) =>
        existsSync(new URL(`docs-site/${id}.mdx`, REPO_ROOT)) ? `${id}.mdx` : `${id}/index.mdx`,
      ),
    );
    expect(
      everyPage().filter((file) => !listed.has(file) && !HIDDEN_PAGES.includes(file)),
      "orphan page, in no nav group",
    ).toEqual([]);
  });

  it.each([PAGE, PROMPT_PAGE, CONTRACT_PAGE])("%s links only to pages that exist", async (page) => {
    expect(pageLinks(await read(page)).filter((target) => !pageExists(target))).toEqual([]);
  });

  // Strict on purpose: a redirect rescues an OUTSIDE link, but an internal link
  // that needs one is rot — the page it names has moved and this page never
  // caught up. Redirects stay for the world's bookmarks; our own links point at
  // the real page.
  it("no page anywhere links at a slug that is not a real page", async () => {
    const dead: string[] = [];
    for (const file of everyPage()) {
      for (const target of pageLinks(await read(`docs-site/${file}`))) {
        if (!pageExists(target)) dead.push(`${file}: ${target}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe("every tool the docs name really exists", () => {
  /** These pages put a tool name in front of a reader's model. A name that
   *  drifted here teaches their agent to call a tool that does not answer. */
  it.each([
    ["vendo_make", PAGE],
    ["vendo_make", DOOR_PAGE],
    ["vendo_make", INSTALL_PAGE],
  ])("%s is named in %s and declared in the apps agent-tool registry", async (tool, page) => {
    expect(await read(page), `${page} must name ${tool}`).toContain(tool);
    const source = await read(AGENT_TOOLS);
    // Either the literal name or core's constant for it.
    const constant = `VENDO_${tool.slice("vendo_".length).toUpperCase()}_TOOL`;
    expect(
      source.includes(`name: "${tool}"`) || source.includes(`name: ${constant}`),
      `${AGENT_TOOLS} must declare ${tool}`,
    ).toBe(true);
  });

  it("vendo_make is core's own constant, not a docs-only alias", async () => {
    expect(await read("packages/core/src/tools.ts")).toContain('export const VENDO_MAKE_TOOL = "vendo_make"');
  });

  it("vendo_delegate, offered only on the in-process path, is the pack's", async () => {
    expect(await read(PACK_PAGE)).toContain("vendo_delegate");
    expect(await read("packages/vendo/src/tool-pack.ts")).toContain('VENDO_DELEGATE_TOOL = "vendo_delegate"');
  });
});

describe("the documented arguments match the real schemas", () => {
  /** The door serves the bound registry's descriptors verbatim, so THIS schema
   *  is what an outside agent sees — all four arguments. */
  it("the registry's vendo_make takes request, context, app, and slot", async () => {
    const source = await read(AGENT_TOOLS);
    const start = source.indexOf("name: VENDO_MAKE_TOOL");
    expect(start, "the make descriptor must still exist").toBeGreaterThan(-1);
    const schema = source.slice(start, source.indexOf('name: "vendo_apps_reseed"', start));
    for (const argument of ["request", "context", "app", "slot"]) {
      expect(schema, `vendo_make must accept \`${argument}\``).toMatch(
        new RegExp(`\\b${argument}: \\{ type: "string"`),
      );
    }
    expect(schema).toContain('required: ["request"]');
  });

  /** `slot` is the one argument both doors carry. If the pack ever loses it,
   *  the two paths have silently diverged. */
  it("the IN-PROCESS pack's vendo_make takes the same four arguments", async () => {
    const source = await read(PACK);
    const start = source.indexOf("function makeAppTool");
    expect(start, "makeAppTool must still exist").toBeGreaterThan(-1);
    const schema = source.slice(start, source.indexOf("function delegateTool", start));
    for (const argument of ["request", "context", "app", "slot"]) {
      expect(schema, `the pack's vendo_make must accept \`${argument}\``).toContain(
        `${argument}: { type: "string"`,
      );
    }
  });

  it("the IN-PROCESS pack still strips every vendo_apps_* tool", async () => {
    const source = await read(PACK);
    expect(source).toContain("if (descriptor.name.startsWith(VENDO_TOOL_PACK_PREFIX)) continue;");
    expect(source, "pack.ts now re-adds a pin tool — the docs' in-process warning is wrong").not.toContain(
      "VENDO_APPS_PIN_TOOL",
    );
  });

  /** The pack the in-process reader gets is exactly the three rows the
   *  quickstart's tool table promises, and no `vendo_apps_*` among them. */
  it("the quickstart's tool table is the pack, and names no vendo_apps_* tool", async () => {
    const page = await read(PACK_PAGE);
    expect(page).toContain("vendo_make");
    expect(page).toContain("vendo_delegate");
    expect(page, "the in-process page must not teach a tool the pack strips").not.toMatch(
      /vendo_apps_[a-z]/,
    );
  });
});

describe("the receipt law the docs teach is the real receipt", () => {
  it("has exactly id, title, status, say — and status's four values", async () => {
    const source = await read("packages/apps/src/contract/make-receipt.ts");
    expect(source).toContain("id: appIdSchema");
    expect(source).toContain("title: z.string().min(1)");
    expect(source).toContain('status: z.enum(["ready", "partial", "building", "failed"])');
    expect(source).toContain("say: z.string().min(1)");
  });

  /** What the docs publish of that receipt is the app-ref envelope: the id, the
   *  title, and the one status a ref may ever carry. */
  it("the envelope page teaches the app ref's id, title, and building status", async () => {
    const page = await read(CONTRACT_PAGE);
    for (const field of ["`appId`", "`title`", '`status: "building"`', "vendo/app-ref@1"]) {
      expect(page, `${CONTRACT_PAGE} must teach ${field}`).toContain(field);
    }
  });

  it("the door page says what vendo_make answers with", async () => {
    expect(await read(DOOR_PAGE)).toMatch(/`vendo_make` answers with an id, a title, a status/);
  });
});

describe("every component the docs tell a reader to import is exported", () => {
  it.each([
    ["VendoSlot", "@vendoai/ui/chrome", "packages/ui/src/chrome/index.ts", SURFACE_PAGE],
    ["VendoToolResult", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", PAGE],
    ["VendoProvider", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", PAGE],
  ])("%s is exported from %s", async (component, specifier, entry, page) => {
    const text = await read(page);
    expect(text, `${page} must name ${component}`).toContain(component);
    expect(text, `${page} must name ${specifier}`).toContain(specifier);
    expect(await read(entry)).toMatch(new RegExp(`\\b${component}\\b`));
  });

  it("wellKnownVendoHandler, the door's discovery route, is a server export", async () => {
    expect(await read(INSTALL_PAGE)).toContain("wellKnownVendoHandler");
    expect(await read("packages/vendo/src/server.ts")).toContain("export function wellKnownVendoHandler");
  });

  it("vendoTools and vendoMastraTools are the shims the quickstart spreads", async () => {
    const page = await read(PAGE);
    expect(page).toContain("vendoTools");
    expect(page).toContain("vendoMastraTools");
    expect(await read("packages/vendo/src/ai-sdk.ts")).toContain("export async function vendoTools");
    expect(await read("packages/vendo/src/mastra.ts")).toContain("export async function vendoMastraTools");
  });

  it("mcp and oauth are real createVendo keys", async () => {
    expect(await read(DOOR_SETUP_PAGE)).toContain("mcp: true");
    const source = await read("packages/vendo/src/types.ts");
    expect(source).toMatch(/^ {2}mcp\?:/m);
    expect(source).toMatch(/^ {2}oauth\?: HostOAuthAdapter;$/m);
  });
});
