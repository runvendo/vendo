import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { doctorErrorCodes, doctorFixRef } from "../../src/cli/doctor-codes.js";

/**
 * Every docs.vendo.run URL the CLI can PRINT has to reach a page that exists.
 *
 * Five of them did not. The docs restructure moved `existing-agents/*` to
 * `existing-agent/*`, retired `/quickstart#the-client-mount`, and replaced the
 * one `agents/verify` playbook with a page per doctor code — and the CLI kept
 * printing the old spellings for months, because nothing in the repo connected a
 * string literal in `src/cli/` to a file in `docs-site/`. This is that
 * connection.
 *
 * Scope: `src/cli/`, which is what the CLI prints — the runtime's own links are
 * a different surface with a different lifecycle.
 *
 * DIRECT resolution only. A `docs.json` redirect is deliberately not accepted:
 * every one of the five stale URLs had one, so a redirect-following check greens
 * a CLI that has been printing retired paths for a year — the redirect table is a
 * compatibility shim for links already printed by SHIPPED binaries, not a licence
 * for the next release to print them too. Anchors are checked only as far as the
 * PAGE (a fragment never reaches the server, so it can select nothing).
 */

const CLI_DIR = new URL("../../src/cli/", import.meta.url);
const DOCS_SITE = new URL("../../../../docs-site/", import.meta.url);

/** `docs.vendo.run/...`, scheme optional, stopping before the sentence
 *  punctuation prose wraps a URL in. */
const DOCS_URL = /docs\.vendo\.run(\/[A-Za-z0-9/#._?=&-]*)?/g;
/** Trailing prose that is not part of the path (`…/mcp.` at the end of a line). */
const TRAILING = /[.,;:)\]]+$/;

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, directory)));
    else if (entry.name.endsWith(".ts")) files.push(new URL(entry.name, directory));
  }
  return files;
}

/** The docs path each printed URL asks for, deduped, with where it came from. */
async function printedDocsPaths(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const remember = (path: string, source: string): void => {
    found.set(path, [...(found.get(path) ?? []), source]);
  };
  for (const file of await sourceFiles(CLI_DIR)) {
    const source = await readFile(file, "utf8");
    const name = fileURLToPath(file).split("/src/cli/")[1]!;
    for (const [, rawPath] of source.matchAll(DOCS_URL)) {
      remember((rawPath ?? "/").replace(TRAILING, ""), name);
    }
  }
  // Built at runtime rather than written as a literal, and the one URL doctor
  // puts in machine-readable output — so it is the one that most has to resolve.
  for (const code of doctorErrorCodes) {
    remember(new URL(doctorFixRef(code)).pathname, `doctorFixRef(${code})`);
  }
  return found;
}

const exists = async (url: URL): Promise<boolean> =>
  await readFile(url, "utf8").then(() => true, () => false);

/** Is there a page here? `<path>.mdx`, or the directory's `index.mdx`. */
async function pageExists(path: string): Promise<boolean> {
  const clean = path.replace(/^\//, "").replace(/\.md$/, "");
  if (clean === "") return await exists(new URL("index.mdx", DOCS_SITE));
  return await exists(new URL(`${clean}.mdx`, DOCS_SITE))
    || await exists(new URL(`${clean}/index.mdx`, DOCS_SITE));
}

describe("every docs.vendo.run URL the CLI prints reaches a page that exists", () => {
  it("resolves each one to a file under docs-site/", async () => {
    const broken: string[] = [];
    for (const [url, sources] of await printedDocsPaths()) {
      // The fragment never reaches the server; only the page can be checked.
      const path = url.split("#")[0]!.split("?")[0]!;
      if (!(await pageExists(path))) {
        broken.push(`docs.vendo.run${url} (printed by ${[...new Set(sources)].join(", ")})`);
      }
    }
    expect(broken, "no page under docs-site/ for").toEqual([]);
  });

  it("found the URLs at all — an empty sweep would pass the check above vacuously", async () => {
    const paths = await printedDocsPaths();
    expect(paths.size).toBeGreaterThan(5);
    // The five the audit caught, in their FIXED spellings.
    const all = [...paths.keys()];
    expect(all).toContain("/existing-agent/ai-sdk");
    expect(all).toContain("/existing-agent/mastra");
    expect(all).toContain("/outside-agents/quickstart");
    expect(all).toContain("/product/mount-the-surface#the-provider");
    expect(all).toContain("/production/troubleshooting/e-wire-001");
  });
});
