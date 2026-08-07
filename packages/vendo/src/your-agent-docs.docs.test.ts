import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Docs-rot gate for the BYO on-ramp page ("Add Vendo to your product's agent").
 * Same shape as mcp-byo-docs.docs.test.ts: the docs live in this repo, so this
 * is a plain test against the sources. It reads files and nothing else — no
 * package import, so it runs without a build.
 *
 * What it holds, and why each claim is load-bearing:
 *  1. the page is published and every nav entry still resolves, with this page
 *     FIRST in its group (it is the on-ramp);
 *  2. every tool name the page puts in a reader's system prompt really exists
 *     in the registry the page is describing;
 *  3. `vendo_make`'s four documented arguments are its real schema properties on
 *     BOTH doors, and the page's remaining asymmetry claim — that the IN-PROCESS
 *     pack carries no `vendo_apps_*` — matches pack.ts. That asymmetry is the one
 *     thing a reader can silently get wrong (an invented tool call), so it is
 *     pinned from both sides;
 *  4. the receipt really has exactly the four fields the page calls a law;
 *  5. every component the page tells a reader to import is really exported from
 *     the entry point the page names;
 *  6. the page never mentions `vendo doctor` (deliberately out of this on-ramp);
 *  7. its links resolve.
 */

const REPO_ROOT = new URL("../../../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, REPO_ROOT), "utf8");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await read(path)) as T;

const PAGE = "docs-site/existing-agents/your-agent.mdx";
const NAV_ENTRY = "existing-agents/your-agent";
const AGENT_TOOLS = "packages/apps/src/agent-tools.ts";
const PACK = "packages/vendo/src/pack.ts";

interface DocsJson {
  navigation: { groups: { group: string; pages: string[] }[] };
}

/** A docs.json page id resolves as `<id>.mdx` or `<id>/index.mdx`. */
const pageExists = (id: string): boolean =>
  existsSync(new URL(`docs-site/${id}.mdx`, REPO_ROOT)) ||
  existsSync(new URL(`docs-site/${id}/index.mdx`, REPO_ROOT));

describe("the BYO on-ramp page is published", () => {
  it("exists with Mintlify frontmatter and a short sidebar title", async () => {
    expect(existsSync(new URL(PAGE, REPO_ROOT)), `${PAGE} must exist`).toBe(true);
    const text = await read(PAGE);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^title: "Add Vendo to your product's agent"$/m);
    expect(text).toMatch(/^sidebarTitle: "/m);
    expect(text).toMatch(/^description: "/m);
  });

  it("is the FIRST entry in the Bring-your-own-agent group", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const group = docs.navigation.groups.find((entry) => entry.group === "Bring your own agent");
    expect(group, "the 'Bring your own agent' group must exist").toBeDefined();
    expect(group?.pages[0]).toBe(NAV_ENTRY);
  });

  it("leaves no nav entry pointing at a file that does not exist", async () => {
    const docs = await readJson<DocsJson>("docs-site/docs.json");
    const missing = docs.navigation.groups
      .flatMap((group) => group.pages)
      .filter((id) => !pageExists(id));
    expect(missing).toEqual([]);
  });

  it("links only to pages that exist", async () => {
    const text = await read(PAGE);
    const targets = [...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((match) => match[1]!);
    const broken = [...new Set(targets)].filter((target) => !pageExists(target.replace(/^\//, "")));
    expect(broken).toEqual([]);
  });
});

describe("every tool the page names really exists", () => {
  /** The page puts these in a reader's SYSTEM PROMPT. A name that drifted here
   *  teaches their agent to call a tool that does not answer. */
  it.each(["vendo_make", "vendo_apps_pin", "vendo_apps_unpin", "vendo_apps_open"])(
    "%s is declared in the apps agent-tool registry",
    async (tool) => {
      const page = await read(PAGE);
      expect(page, `${PAGE} must name ${tool}`).toContain(tool);
      const source = await read(AGENT_TOOLS);
      // Either the literal name or core's constant for it.
      const constant = `VENDO_${tool.slice("vendo_".length).toUpperCase()}_TOOL`;
      expect(
        source.includes(`name: "${tool}"`) || source.includes(`name: ${constant}`),
        `${AGENT_TOOLS} must declare ${tool}`,
      ).toBe(true);
    },
  );

  it("vendo_make is core's own constant, not a docs-only alias", async () => {
    expect(await read("packages/core/src/tools.ts")).toContain('export const VENDO_MAKE_TOOL = "vendo_make"');
  });

  it("vendo_delegate, which the page offers only on the in-process path, is the pack's", async () => {
    const page = await read(PAGE);
    expect(page).toContain("vendo_delegate");
    expect(await read("packages/vendo/src/tool-pack.ts")).toContain('VENDO_DELEGATE_TOOL = "vendo_delegate"');
  });
});

describe("the page's argument tables match the real schemas", () => {
  /** The door serves the bound registry's descriptors verbatim, so THIS schema
   *  is what an outside agent sees — all four arguments the page documents. */
  it("the registry's vendo_make takes request, context, app, and slot", async () => {
    const source = await read(AGENT_TOOLS);
    const start = source.indexOf("name: VENDO_MAKE_TOOL");
    expect(start, "the make descriptor must still exist").toBeGreaterThan(-1);
    const schema = source.slice(start, source.indexOf('name: "vendo_apps_rebase_pin"', start));
    for (const argument of ["request", "context", "app", "slot"]) {
      expect(schema, `vendo_make must accept \`${argument}\``).toMatch(
        new RegExp(`\\b${argument}: \\{ type: "string"`),
      );
    }
    expect(schema).toContain('required: ["request"]');
    const page = await read(PAGE);
    for (const argument of ["request", "context", "app", "slot"]) {
      expect(page).toContain(`\`${argument}\``);
    }
  });

  /** `slot` is the one argument both doors carry, and the page now says so on
   *  both paths. If the pack ever loses it, the page's parity claim is the lie. */
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
    expect(source, "pack.ts now re-adds a pin tool — the page's Path A warning is wrong").not.toContain(
      "VENDO_APPS_PIN_TOOL",
    );
  });

  it("the page says so, in both places it must", async () => {
    const page = await read(PAGE);
    expect(page).toMatch(/in-process pack \*\*does not carry\*\* any\s+`vendo_apps_\*` tool/i);
    expect(page).toMatch(/Do not put\s+`vendo_apps_pin` in a Path A system prompt/);
  });
});

describe("the receipt law the page teaches is the real receipt", () => {
  it("has exactly id, title, status, say — and status's three values", async () => {
    const source = await read("packages/core/src/make-receipt.ts");
    expect(source).toContain("id: appIdSchema");
    expect(source).toContain("title: z.string().min(1)");
    expect(source).toContain('status: z.enum(["ready", "building", "failed"])');
    expect(source).toContain("say: z.string().min(1)");
    const page = await read(PAGE);
    for (const field of ["`say`", "`status`", '"ready"', '"building"', '"failed"']) {
      expect(page, `${PAGE} must teach ${field}`).toContain(field);
    }
  });
});

describe("every component the page tells a reader to import is exported", () => {
  it.each([
    ["VendoSlot", "@vendoai/ui/chrome", "packages/ui/src/chrome/index.ts"],
    ["VendoToolResult", "@vendoai/vendo/react", "packages/vendo/src/react.tsx"],
    ["VendoProvider", "@vendoai/vendo/react", "packages/vendo/src/react.tsx"],
    ["VendoRoot", "@vendoai/vendo/react", "packages/vendo/src/react.tsx"],
  ])("%s is exported from %s", async (component, specifier, entry) => {
    const page = await read(PAGE);
    expect(page, `${PAGE} must name ${component}`).toContain(component);
    expect(page, `${PAGE} must name ${specifier}`).toContain(specifier);
    expect(await read(entry)).toMatch(new RegExp(`\\b${component}\\b`));
  });

  it("wellKnownVendoHandler, the Path B discovery route, is a server export", async () => {
    expect(await read(PAGE)).toContain("wellKnownVendoHandler");
    expect(await read("packages/vendo/src/server.ts")).toContain("export function wellKnownVendoHandler");
  });

  it("vendoTools and vendoMastraTools are the shims the page spreads", async () => {
    const page = await read(PAGE);
    expect(page).toContain("vendoTools");
    expect(page).toContain("vendoMastraTools");
    expect(await read("packages/vendo/src/ai-sdk.ts")).toContain("export async function vendoTools");
    expect(await read("packages/vendo/src/mastra.ts")).toContain("export async function vendoMastraTools");
  });

  it("mcp and oauth are real createVendo keys", async () => {
    const page = await read(PAGE);
    expect(page).toContain("mcp: true");
    const source = await read("packages/vendo/src/server.ts");
    expect(source).toMatch(/^ {2}mcp\?:/m);
    expect(source).toMatch(/^ {2}oauth\?: HostOAuthAdapter;$/m);
  });
});

describe("the page keeps its two deliberate omissions and its one screenshot", () => {
  it("never mentions vendo doctor", async () => {
    expect(await read(PAGE)).not.toMatch(/vendo doctor/);
  });

  it("reuses the committed slot-filled screenshot", async () => {
    const image = "docs-site/images/existing-agents/mcp-walk-slot-filled.png";
    expect(await read(PAGE)).toContain("/images/existing-agents/mcp-walk-slot-filled.png");
    expect(existsSync(new URL(image, REPO_ROOT)), `${image} must exist`).toBe(true);
  });
});

describe("the pasteable guidance stays in step with the skill it was lifted from", () => {
  const SKILL = "examples/claude-code-plugin/skills/make-a-screen/SKILL.md";

  it("the skill still teaches the laws the page's block repeats", async () => {
    const skill = await read(SKILL);
    for (const needle of [/never invent/i, /close to verbatim/i, /`context`/, /`slot`/]) {
      expect(skill).toMatch(needle);
    }
  });

  it("the page's block carries the same four laws", async () => {
    const page = await read(PAGE);
    expect(page).toMatch(/NEVER invent one/);
    expect(page).toMatch(/close to verbatim/i);
    expect(page).toMatch(/NEVER describe it/);
    expect(page).toMatch(/hardcoded figures/i);
  });

  it("credits the skill as the source", async () => {
    expect(await read(PAGE)).toContain("examples/claude-code-plugin/skills/make-a-screen");
  });
});
