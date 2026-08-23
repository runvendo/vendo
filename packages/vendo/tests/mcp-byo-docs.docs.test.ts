import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO-over-MCP story: the docs live in this repo, so this
 * is a plain test against the sources. It reads files and nothing else — no
 * package import, so it runs without a build.
 *
 * What it holds:
 *  1. the setup page exists, is in the nav, and every nav entry still resolves;
 *  2. the setup page opens the door, and both pages' links resolve;
 *  3. the door page no longer claims the door cannot create;
 *  4. the HTTP reference carries the three placement routes;
 *  5. the plugin skill teaches slot targeting and pin etiquette;
 *  6. the plugin's own surfaces point at the walkthrough.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

/** Opening the door and wiring the host's own agent to it. */
const SETUP_PAGE = "docs-site/outside-agents/quickstart.mdx";
const NAV_ENTRY = "outside-agents/quickstart";
/** Where the key lives, what the exchange is, and the broker a host runs
    itself — the operator's half, which the setup page links to rather than
    restates. */
const KEYS_PAGE = "docs-site/outside-agents/service-keys-and-broker.mdx";
/** The Cloud restructure split the door story in three, and this gate follows
    the split rather than holding the docs to a shape they deliberately left:
    the setup page opens the door, `how-the-door-works` is what a call does once
    it is through, and the envelope a tool answers with is taught beside the
    embeds that render it. Every fact below is pinned in the page whose job it
    is. Move a fact between the pages and move it here. */
const DOOR_PAGE = "docs-site/outside-agents/how-the-door-works.mdx";

interface NavGroup {
  group: string;
  pages: (string | NavGroup)[];
}
interface DocsJson {
  navigation: { tabs: { tab: string; groups: NavGroup[] }[] };
  redirects?: { source: string }[];
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

/** Every page id the nav lists. */
const navPages = (docs: DocsJson): string[] =>
  navGroups(docs).flatMap((group) =>
    group.pages.filter((page): page is string => typeof page === "string"),
  );

/** A docs.json page id resolves as `<id>.mdx` or `<id>/index.mdx`. */
const pageExists = (id: string): boolean =>
  existsSync(new URL(`docs-site/${id}.mdx`, REPO_ROOT)) ||
  existsSync(new URL(`docs-site/${id}/index.mdx`, REPO_ROOT));

describe("the BYO-over-MCP pages are published", () => {
  it.each([SETUP_PAGE, DOOR_PAGE])("%s exists with Mintlify frontmatter", async (page) => {
    expect(existsSync(new URL(page, REPO_ROOT)), `${page} must exist`).toBe(true);
    const text = await read(page);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^title: "/m);
    expect(text).toMatch(/^description: "/m);
  });

  it("sits in the outside-agents nav group", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = navGroups(docs).find((entry) => entry.group === "From outside agents");
    expect(group, "the 'From outside agents' group must exist").toBeDefined();
    expect(group?.pages).toContain(NAV_ENTRY);
  });

  it("leaves no nav entry pointing at a file that does not exist", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    expect(navPages(docs).filter((id) => !pageExists(id))).toEqual([]);
  });
});

describe("the setup page opens the door", () => {
  const mustMention: [label: string, needle: string | RegExp][] = [
    ["the connect page a user opens, at the door's own path", "/api/vendo/mcp/connect"],
    ["the createVendo key that opens it", "mcp: true"],
    ["the origin every discovery document derives from", "VENDO_BASE_URL"],
    ["the method that opens the door for a host's own agent", "vendo.agentTools"],
    ["the door internals link", "/outside-agents/how-the-door-works"],
  ];

  it.each(mustMention)("names %s", async (_label, needle) => {
    expect(await read(SETUP_PAGE)).toMatch(needle);
  });

  /** Moved off the setup page with the Cloud-first rewrite: a broker a host
      runs itself and the exchange behind `tokenFor` are operator facts, and the
      setup page carries the happy path only. */
  it.each([
    ["the broker the door trusts", "VENDO_MCP_BROKER_URL"],
    ["the token exchange the backend runs", "RFC 8693"],
  ])("the keys page names %s", async (_label, needle) => {
    expect(await read(KEYS_PAGE)).toMatch(needle);
  });
});

describe("both pages link only to pages that exist", () => {
  it.each([SETUP_PAGE, DOOR_PAGE])("%s", async (page) => {
    const text = await read(page);
    const targets = [...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((match) => match[1]!);
    const broken = [...new Set(targets)].filter((target) => !pageExists(target.replace(/^\//, "")));
    expect(broken).toEqual([]);
  });
});

describe("the door page tells the truth about creation at the door", () => {
  it("no longer calls the door a viewer and runner that cannot create", async () => {
    const text = await read(DOOR_PAGE);
    expect(text).not.toMatch(/viewer and runner/i);
    expect(text).not.toMatch(/creation and editing stay in-product/i);
  });

  it("names vendo_make in the tool listing section and says what it answers with", async () => {
    const text = await read(DOOR_PAGE);
    const start = text.indexOf("## What the agent sees");
    expect(start, "the tool-listing section must still exist").toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("\n## ", start + 1));
    expect(section).toContain("vendo_make");
    expect(section).toContain("saved-apps");
    expect(text).toMatch(/`vendo_make` answers with an id, a title, a status/);
  });
});

describe("the HTTP reference carries the placement routes", () => {
  const ROUTES_PAGE = "docs-site/reference/http-routes.mdx";

  it.each([
    ["`/apps/placements`", "GET"],
    ["`/apps/:id/place`", "POST"],
    ["`/apps/:id/unplace`", "POST"],
  ])("documents %s as a %s row", async (route, method) => {
    const lines = (await read(ROUTES_PAGE)).split("\n");
    const row = lines.find((line) => line.startsWith(`| ${route} |`));
    expect(row, `${ROUTES_PAGE} must carry a table row for ${route}`).toBeDefined();
    expect(row).toContain(`| ${method} |`);
  });

  it("states the slots query and the eviction answer", async () => {
    const text = await read(ROUTES_PAGE);
    expect(text).toContain("?slots=");
    expect(text).toContain("evicted");
  });
});

describe("the plugin skill teaches slot targeting and pin etiquette", () => {
  const SKILL = "examples/claude-code-plugin/skills/make-a-screen/SKILL.md";

  it("keeps its frontmatter", async () => {
    const text = await read(SKILL);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^name: make-a-screen$/m);
    expect(text).toMatch(/^description: /m);
  });

  it("teaches the slot argument and forbids inventing an id", async () => {
    const text = await read(SKILL);
    expect(text).toMatch(/`slot`/);
    expect(text).toMatch(/never invent/i);
  });

  it("teaches pinning as an explicit instruction that replaces", async () => {
    const text = await read(SKILL);
    expect(text).toContain("vendo_apps_pin");
    expect(text).toContain("vendo_apps_unpin");
    expect(text).toMatch(/explicit/i);
    expect(text).toMatch(/replace|evict/i);
  });
});

describe("the plugin's own surfaces point at the walkthrough", () => {
  // Published to the marketplace and to installed plugins, so it is an OUTSIDE
  // link: the restructure keeps it alive through docs.json's permanent redirect
  // rather than by rewriting shipped manifests.
  const DOCS_URL = "https://docs.vendo.run/existing-agents/mcp";

  it("the README covers placement and links the page", async () => {
    const text = await read("examples/claude-code-plugin/README.md");
    expect(text).toContain("vendo_apps_pin");
    expect(text).toContain(DOCS_URL);
  });

  it("the plugin manifest homepages the walkthrough", async () => {
    const manifest = await readJson<{ homepage: string; description: string }>(
      "examples/claude-code-plugin/.claude-plugin/plugin.json",
    );
    expect(manifest.homepage).toBe(DOCS_URL);
    expect(manifest.description).toMatch(/screen/i);
  });

  it("the slug that URL rides on still redirects to a real page", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const slug = new URL(DOCS_URL).pathname;
    const redirect = (docs.redirects ?? []).find((entry) => entry.source === slug) as
      | { source: string; destination: string }
      | undefined;
    expect(redirect, `docs.json must keep a redirect for ${slug}`).toBeDefined();
    expect(pageExists(redirect!.destination.replace(/^\//, ""))).toBe(true);
  });

  it("the marketplace entry says where the screen can land", async () => {
    const marketplace = await readJson<{ plugins: { name: string; description: string }[] }>(
      ".claude-plugin/marketplace.json",
    );
    const entry = marketplace.plugins.find((plugin) => plugin.name === "vendo");
    expect(entry, "the vendo plugin must be listed").toBeDefined();
    expect(entry?.description).toMatch(/slot/i);
  });
});
