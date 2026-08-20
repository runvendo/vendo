import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/agent-prompt.js";
import { NEXT_SERVER_EXTERNALS, SERVER_EXTERNALS_ARRAY } from "../src/cli/framework.js";
import { compositionModuleSource } from "../src/cli/init-scaffolds.js";

/**
 * Docs-rot gate for the three facts this repo publishes about its own install
 * and then drifts from. Each one shipped wrong at least once:
 *
 *  1. the paste. It is written three times — twice in the card (Mintlify strips
 *     JSX expressions from the SSR pass, so the text has to exist as literal
 *     markup as well as a string the copy button can reach) and once in the
 *     README. `buildAgentPrompt` is the original; these are copies, and copies
 *     rot one at a time;
 *  2. the `serverExternalPackages` list. Three pages restate it, and the entry
 *     that matters (`@vendoai/apps`) is invisible when it is missing: the app
 *     still boots and every generated screen fails its checks;
 *  3. what init's composition module actually exports. The existing-agent track
 *     imports from that one file, and a name the page assumed init writes is a
 *     TS2305 on the reader's first build — the `resolvePrincipal` class.
 *
 * It reads sources, so it is a plain test against the repo, not a build check.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");

const CARD = "docs-site/snippets/agent-prompt-card.mdx";
const README = "README.md";
/** The one page that defines `lib/vendo.ts`; the other two import from it. */
const QUICKSTART = "docs-site/existing-agent/quickstart.mdx";
const AI_SDK = "docs-site/existing-agent/ai-sdk.mdx";
const MASTRA = "docs-site/existing-agent/mastra.mdx";
/** Every page that restates the Next externals list rather than linking to it —
 *  including the troubleshooting page a reader lands on when the list is wrong,
 *  which is the worst place of all for it to be wrong. */
const EXTERNALS_PAGES = [
  "docs-site/index.mdx",
  "docs-site/agents/index.mdx",
  "docs-site/production/troubleshooting/e-cfg-004.mdx",
  AI_SDK,
];

/** Line breaks are the one difference a published copy may carry: the README
 *  hard-wraps its fence for readability, and JSX collapses a wrapped text child
 *  to single spaces before it ever reaches the page. Comparing collapsed on
 *  both sides tests the words, which is the thing that rots — rewrapping either
 *  copy is not drift and must not fail. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("every published copy of the paste is the builder's own text", () => {
  it("the card's copy-button string is the docs build of it", async () => {
    // Exact, not collapsed: this literal IS the string the copy button puts on
    // the clipboard, so its bytes are the product.
    const literal = /export const CARD_PROMPT = "([^"]*)";/.exec(await read(CARD));
    expect(literal, `${CARD} must export CARD_PROMPT as one string literal`).not.toBeNull();
    expect(literal![1]).toBe(buildAgentPrompt({ src: "docs", signedIn: false }));
  });

  it("the card's server-rendered twin is the same string", async () => {
    const pre = /<pre className="vendo-agent-prompt-pre">([\s\S]*?)<\/pre>/.exec(await read(CARD));
    expect(pre, `${CARD} must still server-render the paste as literal text`).not.toBeNull();
    expect(collapse(pre![1]!)).toBe(buildAgentPrompt({ src: "docs", signedIn: false }));
  });

  it("the README's block is the same string under its own src", async () => {
    // Anchored on the citation comment so a second ```text fence elsewhere in
    // the README can never be mistaken for the paste.
    const block = /Change it there first\.\s*-->\s*```text\n([\s\S]*?)```/.exec(await read(README));
    expect(block, `${README} must still publish the paste under its citation comment`).not.toBeNull();
    expect(collapse(block![1]!)).toBe(buildAgentPrompt({ src: "readme", signedIn: false }));
  });
});

describe("the Next externals list the docs print is the one init writes", () => {
  it.each(EXTERNALS_PAGES)("%s restates NEXT_SERVER_EXTERNALS verbatim", async (page) => {
    const listed = [...(await read(page)).matchAll(new RegExp(SERVER_EXTERNALS_ARRAY, "g"))].map(
      ([, , names]) => JSON.parse(`[${names}]`) as string[],
    );
    expect(listed.length, `${page} must still print the list`).toBeGreaterThan(0);
    for (const names of listed) expect(names).toEqual([...NEXT_SERVER_EXTERNALS]);
  });
});

/** Every name init's composition module exports, across both shapes it writes
 *  (an auth preset was detected, or it was not). */
const scaffoldExports = (): Set<string> => {
  const names = new Set<string>();
  for (const auth of [null, { preset: "authJs" as const, dependency: "next-auth" }]) {
    for (const [, name] of compositionModuleSource({ serverActions: false, auth }).matchAll(
      /export (?:const|function) (\w+)/g,
    )) {
      names.add(name!);
    }
  }
  return names;
};

/** What a page shows the reader writing into that same file themselves. */
const shownExports = (page: string): Set<string> =>
  new Set(
    [...page.matchAll(/```ts lib\/vendo\.ts[^\n]*\n([\s\S]*?)```/g)].flatMap((block) =>
      [...block[1]!.matchAll(/export (?:const|function) (\w+)/g)].map(([, name]) => name!),
    ),
  );

const composedImports = (page: string): string[] =>
  [...page.matchAll(/import \{ ([^}]*) \} from "@\/lib\/vendo";/g)].flatMap(([, names]) =>
    names!.split(",").map((name) => name.trim()),
  );

describe("the existing-agent track imports only what lib/vendo.ts really holds", () => {
  it("every imported name is one init writes or one the quickstart shows being added", async () => {
    const written = scaffoldExports();
    const shown = shownExports(await read(QUICKSTART));
    // Both halves of the union have to be readable, or a slice that silently
    // matched nothing would pass this test forever — and the split itself is
    // the fact under test: init writes the instance, the reader writes the
    // resolver, and a page that forgets which is which publishes a TS2305.
    expect([...written], "the scaffold's own exports must be readable").toContain("vendo");
    expect(
      [...shown].filter((name) => !written.has(name)),
      "the quickstart must still show what init does not write",
    ).not.toEqual([]);

    const available = new Set([...written, ...shown]);
    const missing: string[] = [];
    for (const file of [QUICKSTART, AI_SDK, MASTRA]) {
      const imported = composedImports(await read(file));
      expect(imported, `${file} must still import from the composition module`).toContain("vendo");
      missing.push(...imported.filter((name) => !available.has(name)).map((name) => `${file}: ${name}`));
    }
    expect(missing).toEqual([]);
  });
});
