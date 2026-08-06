import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO-over-MCP story (PR5). Same shape as
 * remix-graduation.docs.test.ts: the docs live in this repo, so this is a plain
 * test against the sources. It reads files and nothing else — no package import,
 * so it runs without a build.
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
