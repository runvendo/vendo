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
 *  2. the `serverExternalPackages` list. Two pages restate it — the machine-read
 *     playbook and the troubleshooting page a reader lands on when the list is
 *     wrong — and the entry that matters (`@vendoai/apps`) is invisible when it
 *     is missing: the app still boots and every generated screen fails its
 *     checks. The quickstart and the AI SDK walkthrough were copies of their own
 *     until init started writing the property itself, so those two are pinned
 *     the other way round: no list on either, and init still writes it;
 *  3. what init's composition module actually exports. Both existing-agent
 *     walkthroughs import from that one file, and a name a page assumed init
 *     writes is a TS2305 on the reader's first build — the `resolvePrincipal`
 *     class. Init writes that resolver itself now, on the agent-loop arm those
 *     walkthroughs send their readers down, so the docs DESCRIBE the file rather
 *     than adding to it: the how-to page that owns the resolver prints it, and
 *     every export in that print — and every name either walkthrough imports —
 *     has to be one the scaffold really emits.
 *
 * It reads sources, so it is a plain test against the repo, not a build check.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");

const CARD = "docs-site/snippets/agent-prompt-card.mdx";
const README = "README.md";
/** The two walkthroughs. Each one now defines `lib/vendo.ts` for itself and
 *  imports from it; the chooser they hang off carries no code at all. */
const AI_SDK = "docs-site/existing-agent/ai-sdk.mdx";
const MASTRA = "docs-site/existing-agent/mastra.mdx";
const WALKTHROUGHS = [AI_SDK, MASTRA];
/** Every page that restates the Next externals list rather than linking to it —
 *  including the troubleshooting page a reader lands on when the list is wrong,
 *  which is the worst place of all for it to be wrong. */
const EXTERNALS_PAGES = ["docs-site/agents/index.mdx", "docs-site/production/troubleshooting/e-cfg-004.mdx"];
/** And every page pinned the other way: the human quickstart and the AI SDK
 *  walkthrough both handed the list to init, so a copy reappearing on either is
 *  a manual step the reader no longer has. */
const NO_LIST_PAGES = ["docs-site/index.mdx", AI_SDK];

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

  /** The AI SDK walkthrough had a step of its own for this list, and the
   *  quickstart a config block, until init's `framework === "next"` branch
   *  started writing the property. Both pages dropped the sentence that named
   *  init in the restructure — nothing on either says the word `externals` now —
   *  so what stays pinned is the pair that still bites: no page on the setup
   *  path prints the list again (a copy is a manual step the reader no longer
   *  has, and one more thing to rot), and init really does write it. */
  it.each(NO_LIST_PAGES)("%s hands the list to init instead of printing it", async (page) => {
    expect(SERVER_EXTERNALS_ARRAY.test(await read(page)), `${page} must not restate the list`).toBe(false);
    expect(
      await read("packages/vendo/src/cli/init.ts"),
      "init must still write the externals itself",
    ).toContain("missingServerExternals(before)");
  });
});

/** Every name init's composition module exports, across both shapes it writes
 *  (an auth preset was detected, or it was not) on the arm these two pages send
 *  their readers down. */
const scaffoldExports = (): Set<string> => {
  const names = new Set<string>();
  for (const auth of [null, { kind: "preset" as const, preset: "authJs" as const, dependency: "next-auth" }]) {
    for (const [, name] of compositionModuleSource({ serverActions: false, auth, agentLoop: true }).matchAll(
      /export (?:const|function) (\w+)/g,
    )) {
      names.add(name!);
    }
  }
  return names;
};

/** What a page prints as the contents of that same file. */
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

/** The one page that still PRINTS that file. The restructure gave the two
 *  walkthroughs a single job each — spread the tools, render the embeds — and
 *  moved the composition module to the how-to page that owns the resolver, so
 *  the print is pinned there and the imports stay pinned on the walkthroughs. */
const AUTH_PAGE = "docs-site/howto/auth.mdx";

describe("the existing-agent track imports only what lib/vendo.ts really holds", () => {
  it("every name the walkthroughs print and import is one init's scaffold really writes", async () => {
    const written = scaffoldExports();
    // The derivation has to be readable, or a matchAll that silently found
    // nothing would pass this test forever — and BOTH names are the fact under
    // test: init writes the instance AND the resolver on the agent-loop arm, so
    // a page that shows the reader adding either one is teaching a hand-edit to
    // a file init just wrote.
    expect([...written], "the scaffold's own exports must be readable").toContain("vendo");
    expect(
      [...written],
      "init must still write the resolver — the walkthroughs describe it rather than add it",
    ).toContain("resolvePrincipal");

    // One page prints the file; every export in that print has to be one the
    // scaffold emits.
    const shown = shownExports(await read(AUTH_PAGE));
    expect([...shown], `${AUTH_PAGE} must still print init's composition module`).toContain(
      "resolvePrincipal",
    );
    expect(
      [...shown].filter((name) => !written.has(name)),
      `${AUTH_PAGE} prints a lib/vendo.ts export init does not write`,
    ).toEqual([]);

    const pages = new Map<string, string>();
    for (const file of WALKTHROUGHS) pages.set(file, await read(file));

    const missing: string[] = [];
    for (const [file, text] of pages) {
      const imported = composedImports(text);
      expect(imported, `${file} must still import from the composition module`).toContain("vendo");
      missing.push(...imported.filter((name) => !written.has(name)).map((name) => `${file}: ${name}`));
    }
    expect(missing).toEqual([]);
  });
});
