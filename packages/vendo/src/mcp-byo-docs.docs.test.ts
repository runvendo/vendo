import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO-over-MCP story: the docs live in this repo, so this
 * is a plain test against the sources. It reads files and nothing else — no
 * package import, so it runs without a build.
 *
 * What it holds:
 *  1. the page exists, is in the nav, and every nav entry still resolves;
 *  2. the page names the door's make-and-place contract and its links resolve;
 *  3. capabilities/mcp.mdx no longer claims the door cannot create;
 *  4. the HTTP reference carries the three placement routes;
 *  5. the plugin skill teaches slot targeting and pin etiquette;
 *  6. the plugin's own surfaces point at the new page.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

const PAGE = "docs-site/existing-agents/mcp.mdx";
const NAV_ENTRY = "existing-agents/mcp";

interface DocsJson {
  navigation: { groups: { group: string; pages: string[] }[] };
  redirects?: { source: string }[];
}

/** A docs.json page id resolves as `<id>.mdx` or `<id>/index.mdx`. */
const pageExists = (id: string): boolean =>
  existsSync(new URL(`docs-site/${id}.mdx`, REPO_ROOT)) ||
  existsSync(new URL(`docs-site/${id}/index.mdx`, REPO_ROOT));

describe("the BYO-over-MCP page is published", () => {
  it("exists with Mintlify frontmatter", async () => {
    expect(existsSync(new URL(PAGE, REPO_ROOT)), `${PAGE} must exist`).toBe(true);
    const text = await read(PAGE);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^title: "/m);
    expect(text).toMatch(/^description: "/m);
  });

  it("sits in the Bring-your-own-agent nav group", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = docs.navigation.groups.find((entry) => entry.group === "Bring your own agent");
    expect(group, "the 'Bring your own agent' group must exist").toBeDefined();
    expect(group?.pages).toContain(NAV_ENTRY);
  });

  it("leaves no nav entry pointing at a file that does not exist", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const missing = docs.navigation.groups
      .flatMap((group) => group.pages)
      .filter((id) => !pageExists(id));
    expect(missing).toEqual([]);
  });
});

describe("the page teaches the door's make-and-place contract", () => {
  const mustMention: [label: string, needle: string | RegExp][] = [
    ["the make tool", "vendo_make"],
    ["the slot argument", /`slot`/],
    ["the pin tool", "vendo_apps_pin"],
    ["the unpin tool", "vendo_apps_unpin"],
    ["the receipt's say field", /`say`/],
    ["the building status", /"building"/],
    ["the host-side slot component", "VendoSlot"],
    ["the in-process embed it is not", "VendoToolResult"],
    ["the door URL to paste", "/api/vendo/mcp"],
    ["the marketplace install", "/plugin marketplace add runvendo/vendo"],
    ["the plugin install", "/plugin install vendo@vendo"],
    ["the plugin's env var", "VENDO_MCP_URL"],
    ["the door internals link", "/capabilities/mcp"],
  ];

  it.each(mustMention)("names %s", async (_label, needle) => {
    expect(await read(PAGE)).toMatch(needle);
  });

  it("links only to pages that exist", async () => {
    const text = await read(PAGE);
    const targets = [...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((match) => match[1]!);
    const broken = [...new Set(targets)].filter((target) => !pageExists(target.replace(/^\//, "")));
    expect(broken).toEqual([]);
  });
});

describe("capabilities/mcp.mdx tells the truth about creation at the door", () => {
  const DOOR_PAGE = "docs-site/capabilities/mcp.mdx";

  it("no longer calls the door a viewer and runner that cannot create", async () => {
    const text = await read(DOOR_PAGE);
    expect(text).not.toMatch(/viewer and runner/i);
    expect(text).not.toMatch(/creation and editing stay in-product/i);
  });

  it("names vendo_make in the saved-apps section and points at the walkthrough", async () => {
    const text = await read(DOOR_PAGE);
    const start = text.indexOf("## Saved apps ride along");
    expect(start, "the saved-apps section must still exist").toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("\n## ", start + 1));
    expect(section).toContain("vendo_make");
    expect(section).toContain("vendo_apps_pin");
    expect(section).toContain("/existing-agents/mcp");
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

  it("the marketplace entry says where the screen can land", async () => {
    const marketplace = await readJson<{ plugins: { name: string; description: string }[] }>(
      ".claude-plugin/marketplace.json",
    );
    const entry = marketplace.plugins.find((plugin) => plugin.name === "vendo");
    expect(entry, "the vendo plugin must be listed").toBeDefined();
    expect(entry?.description).toMatch(/slot/i);
  });
});
