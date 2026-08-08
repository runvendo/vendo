/**
 * The one recorder every contender's page answers through.
 *
 * The `claude-code` page contract tells that contender to define `window.vendo`
 * itself, so its file still works opened straight off disk. It therefore
 * REPLACES whatever the harness put on the page — which cost that column its
 * rows in the preview's live tool-call feed, while the probe and the floor,
 * which read `window.vendo.calls`, never noticed.
 *
 * So the recorder is installed after the page has loaded, over whatever
 * `window.vendo` is by then, and delegates to it. These tests are the seam: a
 * page that defines its own recorder and a page that does not must feed the
 * parent identically, and the calls the floor scores must be untouched either
 * way.
 *
 * A real browser, because the claim is about which assignment won.
 */
import type { UIPayload } from "@vendoai/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter } from "./render.js";
import { loadWorld, type World } from "./world.js";

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

/** Exactly what `PAGE_CONTRACT` in `claude-code.ts` asks that contender for:
 *  its own `window.vendo`, defined before it draws, answering out of its own
 *  copy of the rows. */
const OWN_RECORDER = `<!doctype html><html lang="en"><head><title>t</title>
<script>
  var TOOLS = { cancel_transfer: { ok: true } };
  window.vendo = { calls: [], callTool: function (name, args) {
    this.calls.push({ name: name, args: args });
    return TOOLS[name] ? { status: "ok", output: TOOLS[name] } : { status: "error", error: { code: "not-found", message: "no tool " + name } };
  } };
</script></head>
<body><button onclick="window.vendo.callTool('cancel_transfer', { id: 'tr_1' })">Cancel transfer</button></body></html>`;

/** A page that leaves the recorder alone, like `diy` writes. */
const NO_RECORDER = `<!doctype html><html lang="en"><head><title>t</title></head>
<body><button onclick="window.vendo.callTool('cancel_transfer', { id: 'tr_1' })">Cancel transfer</button></body></html>`;

const PAYLOAD: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "Alex Rivera" } }],
} as UIPayload;

interface Pressed {
  /** What the feed would have shown: the page's own posts to its parent. */
  readonly posted: ReadonlyArray<Record<string, unknown>>;
  /** What the probe reads and the floor scores. */
  readonly calls: ReadonlyArray<{ name: string; args: unknown }>;
  /** The page's own answer, which the harness must not have swallowed. */
  readonly answer: unknown;
}

/**
 * One press, in a real browser, watched from both sides.
 *
 * `parent` is `window` in an unframed page, so a post to the parent lands on
 * this same page's `message` listener — the report's listener reads the exact
 * same event (`report.ts`, `FEED_SCRIPT`).
 */
async function press(html: string): Promise<Pressed> {
  const visit = await shooter.visit(html);
  try {
    return await visit.page.evaluate(async () => {
      const posted: Array<Record<string, unknown>> = [];
      addEventListener("message", (event: MessageEvent) => posted.push(event.data as Record<string, unknown>));
      const answer = window.vendo.callTool("cancel_transfer", { id: "tr_1" });
      // postMessage to self is delivered as a task, so one turn of the loop.
      await new Promise((settle) => setTimeout(settle, 0));
      return { posted, calls: window.vendo.calls, answer };
    });
  } finally {
    await visit.close();
  }
}

describe("the call feed", () => {
  it("carries a press from a page that defines its own recorder", async () => {
    const { posted } = await press(authoredPage(OWN_RECORDER, world, "claude-code-sonnet"));

    expect(posted).toContainEqual(
      expect.objectContaining({
        genbench: "call",
        contender: "claude-code-sonnet",
        name: "cancel_transfer",
        args: { id: "tr_1" },
      }),
    );
  }, 120_000);

  it("carries a press from a page that leaves the recorder alone", async () => {
    const { posted } = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"));

    expect(posted).toContainEqual(
      expect.objectContaining({ genbench: "call", contender: "diy-sonnet", name: "cancel_transfer" }),
    );
  }, 120_000);

  it("posts a press exactly once, so one contender never doubles another's rows", async () => {
    const own = await press(authoredPage(OWN_RECORDER, world, "claude-code-sonnet"));
    const harness = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"));

    expect(own.posted.filter((message) => message["genbench"] === "call")).toHaveLength(1);
    expect(harness.posted.filter((message) => message["genbench"] === "call")).toHaveLength(1);
  }, 120_000);
});

describe("scoring", () => {
  it("still reads the call off a page that defines its own recorder", async () => {
    const { calls, answer } = await press(authoredPage(OWN_RECORDER, world, "claude-code-sonnet"));

    // The floor grades `window.vendo.calls`; wrapping the recorder must not move
    // what lands there, and must not swallow the page's own answer.
    expect(calls).toEqual([{ name: "cancel_transfer", args: { id: "tr_1" } }]);
    expect(answer).toEqual({ status: "ok", output: { ok: true } });
  }, 120_000);

  it("still answers with the world's canned response where the harness owns the recorder", async () => {
    const { calls, answer } = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"));

    expect(calls).toEqual([{ name: "cancel_transfer", args: { id: "tr_1" } }]);
    expect(answer).toEqual({ status: "ok", output: { ok: true } });
  }, 120_000);

  it("holds on the page the product rendered too", async () => {
    const { posted, calls } = await press(pageHtml(PAYLOAD, world, bundle, "vendo-sonnet"));

    expect(calls).toEqual([{ name: "cancel_transfer", args: { id: "tr_1" } }]);
    expect(posted).toContainEqual(expect.objectContaining({ genbench: "call", contender: "vendo-sonnet" }));
  }, 120_000);
});
