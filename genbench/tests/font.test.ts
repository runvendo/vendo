/**
 * The world's face, in every contender's pixels.
 *
 * The style rubric asks for Onest. Until the world carried the face, "Onest,
 * sans-serif" resolved to the system stack in every column, so the typography
 * line was ungradeable from a screenshot — the one style rule a person could
 * not check by looking. The world folder now ships the face and the harness
 * injects it into every page as the SAME bytes, whoever wrote the page.
 *
 * A real browser, because the claim is about what loaded, not about what the
 * HTML said.
 */
import type { UIPayload } from "@vendoai/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoredPage, bundleMount, fontFace, openBrowser, pageHtml, type Shooter } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let bundle: string;
let shooter: Shooter;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  bundle = await bundleMount();
  shooter = await openBrowser();
}, 120_000);
afterAll(async () => await shooter.close());

/** A line of the theme's own family, which is what makes the face load: a face
 *  nothing asks for stays unloaded, and `document.fonts.check` would then be
 *  answering about a page no contender writes. */
const AUTHORED = `<!doctype html><html lang="en"><head><title>t</title>
<style>body{font-family:var(--vendo-font-family,Onest,sans-serif)}</style></head>
<body><p>Alex Rivera</p></body></html>`;

const TEXT: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "Alex Rivera" } }],
} as UIPayload;

/** What the browser actually ended up with. `check` is the assertion the run
 *  cares about; the face list beside it is what stops that assertion being
 *  vacuous — `document.fonts.check` answers true for a family the page never
 *  declared, so on its own it would pass with no font at all. */
async function facesIn(html: string): Promise<{ check: boolean; faces: string[] }> {
  const visit = await shooter.visit(html);
  try {
    return await visit.page.evaluate(async () => {
      await document.fonts.ready;
      return {
        check: document.fonts.check("14px Onest"),
        faces: [...document.fonts].map((face) => `${face.family.replaceAll('"', "")} ${face.status}`),
      };
    });
  } finally {
    await visit.close();
  }
}

describe("the world's font", () => {
  it("is loaded from the world folder and named by the theme", () => {
    expect(world.font).toBeDefined();
    expect(world.theme.typography.fontFamily).toContain("Onest");
    // Really a woff2, not a stray text file renamed: `wOF2` is the magic number.
    expect(Buffer.from(world.font!, "base64").subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  it("reaches every contender's page as the same bytes", () => {
    const face = fontFace(world);

    expect(face).toContain("@font-face");
    expect(face).toContain("Onest");
    expect(face).toContain(world.font!);
    // vendo mounts a payload; diy and claude-code hand over a document. Both
    // shapes carry the identical block, or the columns are not shot in the same
    // face and the typography rule grades the harness.
    expect(pageHtml(TEXT, world, bundle, "vendo-sonnet")).toContain(face);
    expect(authoredPage(AUTHORED, world, "diy-sonnet")).toContain(face);
    expect(authoredPage(AUTHORED, world, "claude-code-sonnet")).toContain(face);
  });

  it("says nothing at all for a world that ships no face", () => {
    const { font: _font, ...bare } = world;

    expect(fontFace(bare)).toBe("");
    // The bundle carries the product's own built-in Onest face, so the page is
    // never font-free; the control is that the harness added none of its own.
    const page = pageHtml(TEXT, bare, bundle, "vendo-sonnet");
    expect(page.split("@font-face").length).toBe(bundle.split("@font-face").length);
  });
});

describe("the pixels", () => {
  it("render in Onest on a page the contender wrote", async () => {
    const { check, faces } = await facesIn(authoredPage(AUTHORED, world, "diy-sonnet"));

    expect(faces).toContain("Onest loaded");
    expect(check).toBe(true);
  }, 120_000);

  it("render in Onest on the page the product rendered", async () => {
    const { check, faces } = await facesIn(pageHtml(TEXT, world, bundle, "vendo-sonnet"));

    expect(faces).toContain("Onest loaded");
    expect(check).toBe(true);
  }, 120_000);

  it("do not, on the same page from a world with no face", async () => {
    const { font: _font, ...bare } = world;
    const { faces } = await facesIn(authoredPage(AUTHORED, bare, "diy-sonnet"));

    // The control: without the world's asset there is no Onest to load, and the
    // page falls back to the system stack exactly as it did before this slice.
    expect(faces).toEqual([]);
  }, 120_000);
});
