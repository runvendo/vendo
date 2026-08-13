import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO story. The docs live in this repo, so this is a
 * plain test against the sources — it reads files and nothing else, no package
 * import, so it runs without a build.
 *
 * The restructure split the old single `existing-agents/your-agent` page across
 * four pages, one canonical home per fact. Every claim below still bites; each
 * is now pinned on the page whose job that fact is. Move a fact between pages
 * and move its constant here.
 *
 * What it holds, and why each claim is load-bearing:
 *  1. the door-1 quickstart is published and every nav entry still resolves,
 *     with the quickstart FIRST in its group and the overview directly behind
 *     it (the landing page's door card links straight at the quickstart);
 *  2. every tool name the docs put in a reader's system prompt really exists in
 *     the registry the prompt block is describing;
 *  3. `vendo_make`'s four documented arguments are its real schema properties on
 *     BOTH doors, and the remaining asymmetry claim — that the IN-PROCESS pack
 *     carries no `vendo_apps_*` — matches pack.ts. That asymmetry is the one
 *     thing a reader can silently get wrong (an invented tool call), so it is
 *     pinned from both sides and on both pages that state it;
 *  4. the receipt really has exactly the four fields the docs call a law;
 *  5. every component the docs tell a reader to import is really exported from
 *     the entry point they name;
 *  6. the pasteable prompt block stays in step with the skill it was lifted from;
 *  7. every internal link, on every page in the tree, points at a page that
 *     really exists. Redirects do not count: they exist for links the world
 *     already published, and one of ours that needs one is a stale link.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

/** Door 1's on-ramp: init, one spread, one component. */
const PAGE = "docs-site/existing-agents/quickstart.mdx";
const NAV_ENTRY = "existing-agents/quickstart";
/** The block a reader pastes into their own agent's system prompt. */
const PROMPT_PAGE = "docs-site/customize/instructions.mdx";
/** What `vendo_make` answers with, where the screen lands, what a pin displaces. */
const CONTRACT_PAGE = "docs-site/capabilities/generated-ui.mdx";
/** The MCP door's own tools and options — the only door that carries `vendo_apps_*`. */
const DOOR_PAGE = "docs-site/reference/mcp-door.mdx";
/** What the in-process tool pack contains. */
const PACK_PAGE = "docs-site/existing-agents/overview.mdx";
const AGENT_TOOLS = "packages/apps/src/server/doors/agent-tools.ts";
const PACK = "packages/vendo/src/pack.ts";

interface DocsJson {
  navigation: { groups: { group: string; pages: string[] }[] };
}

/** A docs.json page id resolves as `<id>.mdx` or `<id>/index.mdx`. */
const pageExists = (id: string): boolean => {
  const clean = id.replace(/^\//, "").replace(/\.md$/, "");
  if (clean === "") return existsSync(new URL("docs-site/index.mdx", REPO_ROOT));
  return (
    existsSync(new URL(`docs-site/${clean}.mdx`, REPO_ROOT)) ||
    existsSync(new URL(`docs-site/${clean}/index.mdx`, REPO_ROOT))
  );
};

/** Every published page, as a docs-site-relative path. */
const everyPage = (): string[] => {
  const root = new URL("docs-site/", REPO_ROOT).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".mdx") ? [path.slice(root.length)] : [];
    });
  return walk(root.replace(/\/$/, "")).sort();
};

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
    expect(text).toMatch(/^title: "Quickstart: your agent"$/m);
    expect(text).toMatch(/^sidebarTitle: "/m);
    expect(text).toMatch(/^description: "/m);
  });

  it("leads its group, with the overview directly behind it", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = docs.navigation.groups.find((entry) => entry.group === "You already have an agent");
    expect(group, "the 'You already have an agent' group must exist").toBeDefined();
    // The landing page's door card links straight at the quickstart, so the
    // quickstart is the group's first entry and the overview it hands off to
    // sits directly behind it, ahead of the framework notes. Flipping these
    // two back reintroduces the overview hop the landing page removed.
    expect(group?.pages.slice(0, 2)).toEqual([NAV_ENTRY, "existing-agents/overview"]);
  });

  it("leaves no nav entry pointing at a file that does not exist", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const missing = docs.navigation.groups
      .flatMap((group) => group.pages)
      .filter((id) => !pageExists(id));
    expect(missing).toEqual([]);
  });

  it("lists every published page in the nav, and nothing else", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const listed = new Set(
      docs.navigation.groups
        .flatMap((group) => group.pages)
        .map((id) => (existsSync(new URL(`docs-site/${id}.mdx`, REPO_ROOT)) ? `${id}.mdx` : `${id}/index.mdx`)),
    );
    expect(everyPage().filter((file) => !listed.has(file)), "orphan page, in no nav group").toEqual([]);
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
  /** The prompt page puts these in a reader's SYSTEM PROMPT. A name that drifted
   *  there teaches their agent to call a tool that does not answer. */
  it.each([
    ["vendo_make", PROMPT_PAGE],
    ["vendo_apps_pin", PROMPT_PAGE],
    ["vendo_apps_unpin", PROMPT_PAGE],
    // Door-only, so it is taught where the door's tool list is.
    ["vendo_apps_open", DOOR_PAGE],
  ])("%s is named in the docs and declared in the apps agent-tool registry", async (tool, page) => {
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
   *  is what an outside agent sees — all four arguments the page documents. */
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
    const page = await read(PROMPT_PAGE);
    for (const argument of ["request", "context", "app", "slot"]) {
      expect(page).toContain(`\`${argument}\``);
    }
  });

  /** `slot` is the one argument both doors carry, and the docs say so on both
   *  paths. If the pack ever loses it, the docs' parity claim is the lie. */
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

  /** Stated on both pages a reader can arrive at with a pin tool in mind: the
   *  prompt block they paste, and the page that teaches placement. */
  it.each([PROMPT_PAGE, CONTRACT_PAGE])("%s says the in-process pack carries no pin tool", async (page) => {
    expect(await read(page)).toMatch(/in-process tool pack\s+carries no `vendo_apps_\*` tool/i);
  });

  it("the prompt block gates its pin section on reaching Vendo over MCP", async () => {
    const page = await read(PROMPT_PAGE);
    expect(page).toMatch(/only if your agent reaches Vendo over MCP/i);
    expect(page).toMatch(/teaching an agent about a tool it does not have/i);
  });
});

describe("the receipt law the docs teach is the real receipt", () => {
  it("has exactly id, title, status, say — and status's four values", async () => {
    const source = await read("packages/apps/src/contract/make-receipt.ts");
    expect(source).toContain("id: appIdSchema");
    expect(source).toContain("title: z.string().min(1)");
    expect(source).toContain('status: z.enum(["ready", "partial", "building", "failed"])');
    expect(source).toContain("say: z.string().min(1)");
    const page = await read(CONTRACT_PAGE);
    for (const field of ["`say`", "`status`", '"ready"', '"partial"', '"building"', '"failed"']) {
      expect(page, `${CONTRACT_PAGE} must teach ${field}`).toContain(field);
    }
  });
});

describe("every component the docs tell a reader to import is exported", () => {
  it.each([
    ["VendoSlot", "@vendoai/ui/chrome", "packages/ui/src/chrome/index.ts", CONTRACT_PAGE],
    ["VendoToolResult", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", PAGE],
    ["VendoProvider", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", PAGE],
  ])("%s is exported from %s", async (component, specifier, entry, page) => {
    const text = await read(page);
    expect(text, `${page} must name ${component}`).toContain(component);
    expect(text, `${page} must name ${specifier}`).toContain(specifier);
    expect(await read(entry)).toMatch(new RegExp(`\\b${component}\\b`));
  });

  it("wellKnownVendoHandler, the door's discovery route, is a server export", async () => {
    expect(await read(DOOR_PAGE)).toContain("wellKnownVendoHandler");
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
    expect(await read(DOOR_PAGE)).toContain("mcp: true");
    const source = await read("packages/vendo/src/types.ts");
    expect(source).toMatch(/^ {2}mcp\?:/m);
    expect(source).toMatch(/^ {2}oauth\?: HostOAuthAdapter;$/m);
  });
});

describe("the pasteable guidance stays in step with the skill it was lifted from", () => {
  const SKILL = "examples/claude-code-plugin/skills/make-a-screen/SKILL.md";

  it("the skill still teaches the laws the prompt block repeats", async () => {
    const skill = await read(SKILL);
    for (const needle of [/never invent/i, /close to verbatim/i, /`context`/, /`slot`/]) {
      expect(skill).toMatch(needle);
    }
  });

  it("the prompt block carries the same four laws", async () => {
    const page = await read(PROMPT_PAGE);
    expect(page).toMatch(/NEVER invent one/);
    expect(page).toMatch(/close to verbatim/i);
    expect(page).toMatch(/NEVER describe it/);
    expect(page).toMatch(/hardcoded figures/i);
  });

  it("credits the skill as the source", async () => {
    expect(await read(PROMPT_PAGE)).toContain("examples/claude-code-plugin/skills/make-a-screen");
  });
});
