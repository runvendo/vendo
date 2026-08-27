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
 *  1. both door-1 walkthroughs are published and every nav entry still
 *     resolves, with the chooser FIRST in its group and pointing at both of
 *     them (every inbound link — landing cards, README, init receipts — names
 *     the chooser's slug, so a reader who lands there has to be routed on);
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

/** Door 1's on-ramp, one complete walkthrough per framework: init, one spread,
 *  one component. Also the pages that say what the in-process pack contains. */
const AI_SDK_PAGE = "docs-site/existing-agent/ai-sdk.mdx";
const MASTRA_PAGE = "docs-site/existing-agent/mastra.mdx";
const PACK_PAGES = [AI_SDK_PAGE, MASTRA_PAGE];
/** The chooser those two hang off. It holds no code — its whole job is the two
 *  links — but its slug is the one the world already published. */
const CHOOSER_PAGE = "docs-site/existing-agent/quickstart.mdx";
const NAV_ENTRY = "existing-agent/quickstart";
/** The two "Make it yours" pages both walkthroughs route their readers to next.
 *  The pasted system-prompt block is gone — init writes the brief now, and the
 *  one line that tips a model toward a screen is taught on the screens page —
 *  so what a reader's model ends up being told about screens and tools lives
 *  here, and the facts that hung off that block are pinned on these. */
const SCREENS_PAGE = "docs-site/howto/screens.mdx";
const TOOLS_PAGE = "docs-site/howto/tools.mdx";
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
  /** A group's own landing page. Mintlify serves it when the group header is
   *  clicked, so it is a nav entry that never appears in `pages` — miss it and
   *  a published page reads as an orphan. */
  root?: string;
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

/** Every page id the nav lists, in nav order — group roots included. */
const navPages = (docs: DocsJson): string[] =>
  navGroups(docs).flatMap((group) => [
    ...(group.root === undefined ? [] : [group.root]),
    ...group.pages.filter((page): page is string => typeof page === "string"),
  ]);

/** The first entry a reader meets under a group: its first page, or — when the
 *  group opens with a nested group — that group's own landing page. */
const firstEntry = (group: NavGroup): string | undefined => {
  const first = group.pages[0];
  return typeof first === "string" ? first : first?.root;
};

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

/** Pages kept OUT of the nav on purpose. Mintlify still serves them by URL, and
    docs.json's redirects still land on several of them, so they are published
    pages with no sidebar row rather than dead files.

    The agents playbook is machine-fetched (vendo.run/agents.md), so the sidebar
    hides the raw playbook. The rest came off the sidebar in the Cloud-first
    restructure: the sidebar now carries the three doors and the how-to track,
    and the depth behind them — the backend SDK, orgs and tenancy, the product
    surface, the app-lifecycle pages — is reached from the pages that need it. */
const HIDDEN_PAGES = [
  "agents/index.mdx",
  "backend/automate.mdx",
  "backend/converse.mdx",
  "backend/quickstart.mdx",
  "backend/run.mdx",
  "backend/your-own-surface.mdx",
  "capabilities/tenant-connectors.mdx",
  "changelog/overview.mdx",
  "existing-agent/embeds.mdx",
  "generated/import-and-fork.mdx",
  "generated/in-client-venue.mdx",
  "outside-agents/your-own-agent.mdx",
  "product/how-it-works.mdx",
  "product/mount-the-surface.mdx",
  "users-orgs/erasing-a-user.mdx",
  "users-orgs/limits.mdx",
  "users-orgs/org-policy.mdx",
  "users-orgs/org-workspace.mdx",
  "users-orgs/orgs-and-memberships.mdx",
  "users-orgs/sharing.mdx",
  "users-orgs/tenants.mdx",
  "users-orgs/your-users.mdx",
];

/** Root-relative page links in an .mdx body. Assets are not pages. */
const pageLinks = (text: string): string[] =>
  [...new Set([...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((match) => match[1]!))].filter(
    (target) => !/^\/(images|logo|snippets)\//.test(target),
  );

describe("the BYO on-ramp pages are published", () => {
  it.each([
    [CHOOSER_PAGE, "Quickstart: in your agent"],
    [AI_SDK_PAGE, "Quickstart: AI SDK"],
    [MASTRA_PAGE, "Quickstart: Mastra"],
  ])("%s exists with Mintlify frontmatter and the sidebar title %s", async (page, sidebarTitle) => {
    expect(existsSync(new URL(page, REPO_ROOT)), `${page} must exist`).toBe(true);
    const text = await read(page);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^title: "/m);
    expect(text).toContain(`\nsidebarTitle: "${sidebarTitle}"\n`);
    expect(text).toMatch(/^description: "/m);
  });

  it("the chooser leads its group", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = navGroups(docs).find((entry) => entry.group === "In your existing agent");
    expect(group, "the 'In your existing agent' group must exist").toBeDefined();
    // Every inbound link — the landing page's door card, the README, init's
    // Continue receipts — names this slug, so it stays the group's first entry.
    // It leads as the nested quickstart group's own landing page.
    expect(firstEntry(group!)).toBe(NAV_ENTRY);
  });

  it("the chooser routes to both walkthroughs", async () => {
    // Its only job. A chooser that lost a card is a dead end for half the
    // readers every inbound link sends to it.
    const text = await read(CHOOSER_PAGE);
    for (const target of ["/existing-agent/ai-sdk", "/existing-agent/mastra"]) {
      expect(text, `${CHOOSER_PAGE} must link to ${target}`).toContain(`href="${target}"`);
    }
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

  it.each([CHOOSER_PAGE, ...PACK_PAGES, SCREENS_PAGE, TOOLS_PAGE, CONTRACT_PAGE])(
    "%s links only to pages that exist",
    async (page) => {
      expect(pageLinks(await read(page)).filter((target) => !pageExists(target))).toEqual([]);
    },
  );

  /** The pasted system-prompt block is gone with the act-two quickstart, and
   *  the `#teach-your-model-when-to-build-ui` fragment it lived under is
   *  retired for good. A link still carrying it scrolls to the top of some page
   *  with no error anywhere — the one failure `pageLinks` cannot see, because
   *  it drops fragments. */
  it("the retired teach-your-model anchor is linked nowhere", async () => {
    const stale: string[] = [];
    for (const file of everyPage()) {
      if ((await read(`docs-site/${file}`)).includes("#teach-your-model-when-to-build-ui)")) {
        stale.push(file);
      }
    }
    expect(stale, "links at the retired teach-your-model anchor").toEqual([]);
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
    // The two walkthroughs stopped enumerating the pack in the restructure —
    // they teach the prefix and the filters instead (pinned below). The pages
    // that still put the NAME in front of a reader's model are these.
    ["vendo_make", TOOLS_PAGE],
    ["vendo_make", CONTRACT_PAGE],
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

  /** The registry's `vendo_make` is the source of truth, so the expected list is
   *  READ FROM IT rather than repeated here. A literal on both sides is two
   *  copies of one list that cannot disagree: this test was GREEN while the pack
   *  was missing `component`, which is how the ✦ on a host component shipped
   *  dead for every agent adopted via `vendoAiSdkTools`/`vendoMastraTools`. The
   *  pack's schema is CLOSED, so an argument the door offers and the pack omits
   *  is unreachable, not merely absent. */
  it("the IN-PROCESS pack's vendo_make takes every argument the registry's does", async () => {
    const door = await read(AGENT_TOOLS);
    const properties = door.indexOf("properties: {", door.indexOf("name: VENDO_MAKE_TOOL"));
    const offered = door.slice(properties, door.indexOf('required: ["request"]', properties));
    const args = [...offered.matchAll(/(\w+): \{ type: "string"/g)].map(([, name]) => name);
    // The derivation itself has to be checked, or a slice that silently matched
    // nothing would pass this test forever.
    expect(args, "the door's own argument list must be readable").toContain("request");

    const source = await read(PACK);
    const start = source.indexOf("function makeAppTool");
    expect(start, "makeAppTool must still exist").toBeGreaterThan(-1);
    const schema = source.slice(start, source.indexOf("function delegateTool", start));
    for (const argument of args) {
      expect(schema, `the pack's vendo_make must accept \`${argument}\``).toContain(
        `${argument}: { type: "string"`,
      );
    }
  });

  it("the IN-PROCESS pack still strips every vendo_apps_* tool", async () => {
    const source = await read(PACK);
    expect(source).toContain("if (descriptor.name.startsWith(VENDO_TOOL_PACK_PREFIX)) continue;");
    expect(source, "pack.ts now re-adds a pin tool — the docs' no-vendo_apps_* guard is wrong").not.toContain(
      "VENDO_APPS_PIN_TOOL",
    );
  });

  /** The restructure cut the per-tool enumeration from both walkthroughs — the
   *  names live on the pages that own them now, pinned above, and the code-side
   *  guard that the pack really carries `vendo_make` and `vendo_delegate` is
   *  ai-sdk.test.ts / mastra.test.ts against the built pack. What each
   *  walkthrough promises instead is the SHAPE: one prefix, two filters. Both
   *  halves are still a reader's-model fact — a tool arrives namespaced, and a
   *  host who wants fewer of them passes these two option names. */
  it.each(PACK_PAGES)("%s summarises the pack the in-process reader gets", async (page) => {
    const text = await read(page);
    expect(text, `${page} must name the prefix every pack tool arrives under`).toContain("`vendo_` prefix");
    for (const option of ["include", "exclude"]) {
      expect(text, `${page} must name \`${option}\``).toContain(`\`${option}\``);
    }
    expect(await read("packages/core/src/tools.ts")).toContain('export const VENDO_TOOL_PREFIX = "vendo_"');
    const pack = await read("packages/vendo/src/tool-pack.ts");
    for (const option of ["include", "exclude"]) {
      expect(pack, `the pack filter must really take \`${option}\``).toMatch(
        new RegExp(`^ {2}${option}\\?: string\\[\\];$`, "m"),
      );
    }
  });

  /** And no `vendo_apps_*` among them — on the walkthroughs, and on the two
   *  how-to pages an in-process reader is sent to next. */
  it.each([...PACK_PAGES, SCREENS_PAGE, TOOLS_PAGE])("%s names no vendo_apps_* tool", async (page) => {
    expect(await read(page), "the in-process path must not teach a tool the pack strips").not.toMatch(
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
    // VendoProvider left both walkthroughs when embeds learned to find the
    // wire bare (#1583) — the provider is settings now, taught on the embeds page.
    ["VendoSlot", "@vendoai/ui/chrome", "packages/ui/src/chrome/index.ts", SURFACE_PAGE],
    ["VendoToolResult", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", AI_SDK_PAGE],
    ["VendoToolResult", "@vendoai/vendo/react", "packages/vendo/src/react.tsx", MASTRA_PAGE],
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

  it("vendoTools and vendoMastraTools are the shims each walkthrough spreads", async () => {
    expect(await read(AI_SDK_PAGE)).toContain("vendoTools");
    expect(await read(MASTRA_PAGE)).toContain("vendoMastraTools");
    expect(await read("packages/vendo/src/ai-sdk.ts")).toContain("export async function vendoTools");
    expect(await read("packages/vendo/src/mastra.ts")).toContain("export async function vendoMastraTools");
  });

  /** The AI SDK walkthrough no longer prints a whole chat component — it prints
   *  the ONE branch a reader adds to their own message loop, and that branch is
   *  `isVendoToolPart`. It stays right only while the helper matches on the tool
   *  NAME: the hand-written `part.type === "dynamic-tool"` it replaces was right
   *  only while the shim kept building every tool with `dynamicTool`, and a shim
   *  that declared them by name would have left the page's only branch matching
   *  nothing, with no error anywhere. */
  it.each([AI_SDK_PAGE, MASTRA_PAGE, CONTRACT_PAGE])(
    "the branch %s tells a reader to add matches on the tool name, not the part shape",
    async (page) => {
      expect(await read(page)).toContain("isVendoToolPart(part)");
      expect(await read("packages/ui/src/embeds.ts")).toContain(
        "getToolName(part).startsWith(VENDO_TOOL_PREFIX)",
      );
    },
  );

  it("mcp and oauth are real createVendo keys", async () => {
    expect(await read(DOOR_SETUP_PAGE)).toContain("mcp: true");
    const source = await read("packages/vendo/src/types.ts");
    expect(source).toMatch(/^ {2}mcp\?:/m);
    expect(source).toMatch(/^ {2}oauth\?: HostOAuthAdapter;$/m);
  });
});
