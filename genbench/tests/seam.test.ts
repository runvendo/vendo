/**
 * The one recorder every contender's page answers through.
 *
 * A page may define `window.vendo` itself, and one that does REPLACES whatever
 * the harness put there — which cost that column its rows in the preview's live
 * tool-call feed, while the probe and the floor, which read `window.vendo.calls`,
 * never noticed. The `claude-code` contract used to ASK for its own recorder, so
 * its file would work opened straight off disk; the shared `HARNESS_CONTRACT`
 * asks neither baseline for one now, and a model that writes one anyway must
 * still be read the same way as one that does not.
 *
 * So the recorder is installed after the page has loaded, over whatever
 * `window.vendo` is by then, and delegates to it. These tests are the seam: a
 * page that defines its own recorder and a page that does not must feed the
 * parent identically, and the calls the floor scores must be untouched either
 * way.
 *
 * A real browser, because the claim is about which assignment won.
 */
import { chromium } from "@playwright/test";
import type { Json, UIPayload } from "@vendoai/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { writePreview } from "../src/report.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { writeCase, type CaseResult } from "../src/run.js";
import { cannedResponse, loadWorld, type World } from "../src/world.js";

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

/** A page that brings its own `window.vendo`, defined before it draws and
 *  answering out of its own copy of the rows — what a model writes when it
 *  decides it needs a recorder, whatever the contract told it. */
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
  /** What the probe reads and the floor scores. A guarded call carries what the
   *  guard did with it as well (`status`, `approvalId`). */
  readonly calls: ReadonlyArray<{ name: string; args: unknown; status?: string; approvalId?: string }>;
  /** The page's own answer, which the harness must not have swallowed. */
  readonly answer: unknown;
}

/** The world's cancel — a tool with no canned rows, so the world declares it a
 *  write and the seam guards it. */
const WRITE = { name: "cancel_transfer", args: { id: "tr_1" } } as const;

/** And one that HAS rows, which is what makes it a read: answered on the spot. */
const READ = { name: "list_transfers", args: { limit: 5 } } as const;

/** What that read answers with, out of the world itself. */
const transferRows = (): unknown => cannedResponse(world.tools.find((tool) => tool.name === READ.name)!);

/**
 * One press, in a real browser, watched from both sides.
 *
 * `parent` is `window` in an unframed page, so a post to the parent lands on
 * this same page's `message` listener — the report's listener reads the exact
 * same event (`report.ts`, `FEED_SCRIPT`).
 */
async function press(html: string, call: { name: string; args: Json } = WRITE): Promise<Pressed> {
  const visit = await shooter.visit(html);
  try {
    return await visit.page.evaluate(async (asked: { name: string; args: Json }) => {
      const posted: Array<Record<string, unknown>> = [];
      addEventListener("message", (event: MessageEvent) => posted.push(event.data as Record<string, unknown>));
      const answer = window.vendo.callTool(asked.name, asked.args);
      // A post to self is delivered as a TASK, and the guard's approval posts one
      // more from a microtask, so the read waits for the loop to go quiet rather
      // than for a fixed number of turns — which is what the two kinds of message
      // racing each other's task source would otherwise make this depend on.
      let seen = -1;
      while (seen !== posted.length) {
        seen = posted.length;
        await new Promise((settle) => setTimeout(settle, 5));
      }
      return { posted, calls: window.vendo.calls, answer };
    }, call);
  } finally {
    await visit.close();
  }
}

/** Every row the live feed would have drawn, in the order it heard them. */
const feed = (pressed: Pressed): ReadonlyArray<Record<string, unknown>> =>
  pressed.posted.filter((message) => message["genbench"] === "call");

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

    // The PRESS, once each. The harness's own recorder guards a write and posts
    // the approval that follows it, which is the guard's row and not a second
    // reading of the press — so the count is taken on rows that carry no
    // approval, which is what a doubled press would show up in.
    expect(own.posted.filter((message) => message["genbench"] === "call")).toHaveLength(1);
    expect(feed(harness).filter((message) => message["approved"] === undefined)).toHaveLength(1);
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
    const { calls, answer } = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"), READ);

    expect(calls).toEqual([READ]);
    expect(answer).toEqual({ status: "ok", output: transferRows() });
  }, 120_000);

  it("holds on the page the product rendered too", async () => {
    const { posted, calls } = await press(pageHtml(PAYLOAD, world, bundle, "vendo-sonnet"), READ);

    expect(calls).toEqual([READ]);
    expect(posted).toContainEqual(expect.objectContaining({ genbench: "call", contender: "vendo-sonnet" }));
  }, 120_000);
});

// ------------------------------------------------------------- the guard

/**
 * What a WRITE answers with (2026-08-18), and where the guard's round trip lands.
 *
 * The real product confirms a destructive call OUTSIDE the screen: the host
 * answers `pending-approval` at press time, the control's own outcome slot paints
 * "Waiting for your approval", and the decision arrives from somewhere the screen
 * does not draw. The benched seam answered every call `{status:"ok"}` on the spot,
 * so the one confirmation this product actually ships could not paint on any page
 * here — while a contender following its doctrine and building no confirm step of
 * its own was failed on rubric lines asking for one.
 *
 * So a tool the world declares a write is parked and then approved, by the same
 * injected bytes on every column's page. Reads are untouched: a screen fetching
 * what it shows must never wait on an approval to draw.
 */
describe("the guard", () => {
  it("parks a write at press time, and approves it a tick later", async () => {
    const pressed = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"));

    expect(pressed.answer).toEqual({ status: "pending-approval", approvalId: "apr_1" });
    // ONE call — the guard is a round trip, not a second press — carrying what
    // the guard did with it beside the name and arguments the floor grades.
    expect(pressed.calls).toEqual([{ ...WRITE, status: "ok", approvalId: "apr_1" }]);
    // And both halves reach the live feed: the ask, then the approval that
    // released it, tagged with the id that ties them together.
    expect(feed(pressed)).toEqual([
      expect.objectContaining({ contender: "diy-sonnet", name: WRITE.name, args: WRITE.args }),
      expect.objectContaining({ contender: "diy-sonnet", name: WRITE.name, approved: "apr_1" }),
    ]);
  }, 120_000);

  it("answers a read on the spot, with no approval anywhere in it", async () => {
    const pressed = await press(authoredPage(NO_RECORDER, world, "diy-sonnet"), READ);

    expect(pressed.answer).toEqual({ status: "ok", output: transferRows() });
    expect(pressed.calls[0]).not.toHaveProperty("approvalId");
    expect(feed(pressed)).toHaveLength(1);
  }, 120_000);

  it("guards the page the product rendered by the same bytes", async () => {
    const pressed = await press(pageHtml(PAYLOAD, world, bundle, "vendo-sonnet"));

    expect(pressed.answer).toEqual({ status: "pending-approval", approvalId: "apr_1" });
    expect(pressed.calls).toEqual([{ ...WRITE, status: "ok", approvalId: "apr_1" }]);
  }, 120_000);
});

/** A screen whose one control is bound to a write, as the paint gate emits an
 *  action binding: the Kit's Button, its `onClick` naming the tool
 *  (`isActionBinding` in `ui/src/tree/renderer.tsx`). */
const GUARDED: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{
    id: "root",
    component: "Button",
    props: { label: "Cancel transfer", onClick: { $action: WRITE.name, payload: WRITE.args } },
  }],
} as UIPayload;

describe("what the product paints on a guarded press", () => {
  it("is its own pending-approval notice, in the control's outcome slot", async () => {
    const visit = await shooter.visit(pageHtml(GUARDED, world, bundle, "vendo-sonnet"));
    try {
      await visit.page.getByRole("button", { name: "Cancel transfer" }).click();
      const notice = visit.page.locator("[data-vendo-notice=pending-approval]");
      await notice.waitFor({ timeout: 10_000 });

      // The product's own words for a parked call (`outcomeNotice` in
      // `ui/src/tree/renderer.tsx`) — the confirmation this product actually
      // ships, painting on a benchmark page for the first time.
      expect(await notice.innerText()).toContain("Waiting for your approval");
      expect(await visit.page.evaluate(() => window.vendo.calls.map((call) => call.name))).toEqual([WRITE.name]);
    } finally {
      await visit.close();
    }
  }, 120_000);
});

// ------------------------------------------------------- the reader's half

/**
 * The seam's OTHER half, and the half nothing crossed until now.
 *
 * `seam` writes these posts; `FEED_SCRIPT` in `report.ts` reads them — and each
 * side has only ever been checked against a stub of the other: the writer
 * against a listener this file installs, the reader against a string assertion
 * in `report.test.ts`. Neither could ever disagree with the other, so the
 * reader trusting a payload field the writer cannot vouch for went unseen.
 *
 * So this drives both REAL sides over one real report page: the real writer
 * puts two contenders' pages on disk, the real reporter renders them, and a
 * real browser presses inside a real frame.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  wiredActions: { pass: true, pressed: 1, bindings: [] },
  pass: true,
};

const GRADED: JudgeResult = { lines: [], degraded: false };

const resultFor = (contender: string): CaseResult => ({
  run: "run-1",
  contender,
  model: "claude-sonnet-5",
  case: "pending-transfers",
  prompt: "Show my pending transfers.",
  lane: "screen",
  shape: "table",
  floor: PASSING,
  timing: { settledMs: 1 },
  cost: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }, usd: 0 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: "hash",
  caseHash: "case-hash",
  judged: GRADED,
  judgeContract: JudgeContract,
  gitSha: "0".repeat(40),
  agentSdkVersion: "0.0.0",
});

const SHOT: Shot = { png: PNG, tables: [], visibleText: "", dom: "", renders: true, consoleErrors: [] };

/** Every identity the feed is showing, top row first, with whatever the guard
 *  wrote on the row it resolved. */
type Rows = Array<{ who: string; tool: string; tag: string }>;

describe("the feed's identity", () => {
  it("reads a call's contender off the frame that sent it, never off what the frame said", async () => {
    const contenders = ["vendo-sonnet", "diy-sonnet"];
    const runDir = await mkdtemp(join(tmpdir(), "genbench-feed-"));
    const results = contenders.map(resultFor);
    for (const result of results) {
      await writeCase(runDir, {
        outcome: { artifact: NO_RECORDER, blocking: [], format: "html", snapshots: [], settledMs: 1 },
        html: authoredPage(NO_RECORDER, world, result.contender),
        shot: SHOT,
        result,
      });
    }
    const preview = await writePreview({ runDir, runId: "run-1", results, worlds: {} });

    // A viewport wide and tall enough that both columns sit in one row above the
    // fold, because the report's frames load lazily.
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    try {
      await page.goto(pathToFileURL(preview).href);
      const frame = page.frames().find((candidate) => candidate.url().includes("diy-sonnet"));
      expect(frame).toBeDefined();

      const rows = async (): Promise<Rows> =>
        await page.evaluate(() =>
          [...document.querySelectorAll("#feed li")].map((row) => ({
            who: row.querySelector(".who")?.textContent ?? "",
            tool: row.querySelector("code")?.textContent ?? "",
            tag: row.querySelector(".approved")?.textContent ?? "",
          })),
        );

      // The honest press, through the real recorder, from the real frame. ONE
      // row, because `cancel_transfer` is a write and the guard's approval is
      // that call's outcome rather than a second call: it lands on the row
      // already showing the ask, which is what a person who pressed one button
      // has to be able to read.
      await frame!.evaluate(() => window.vendo.callTool("cancel_transfer", { id: "tr_1" }));
      await expect.poll(rows, { timeout: 10_000 }).toEqual([
        { who: "diy-sonnet", tool: "cancel_transfer", tag: "✓ approved" },
      ]);

      // The same frame, now claiming to be the column beside it. A document a
      // contender wrote can name any contender; only the frame it arrived in
      // says who it really is.
      await frame!.evaluate(() =>
        parent.postMessage(
          { genbench: "call", contender: "vendo-sonnet", name: "transfer_money", args: { usd: 900 }, ts: Date.now() },
          "*",
        ),
      );
      await expect.poll(rows, { timeout: 10_000 }).toEqual([
        { who: "diy-sonnet", tool: "transfer_money", tag: "" },
        { who: "diy-sonnet", tool: "cancel_transfer", tag: "✓ approved" },
      ]);

      // And a frame the report never embedded — a child a contender's own page
      // added — is not a contender at all, whatever it calls itself.
      await frame!.evaluate(async () => {
        const child = document.createElement("iframe");
        child.srcdoc = `<script>top.postMessage({ genbench: "call", contender: "vendo-sonnet", name: "wire_funds", args: {}, ts: Date.now() }, "*")<\/script>`;
        document.body.append(child);
        await new Promise((settle) => child.addEventListener("load", settle));
      });
      await page.waitForTimeout(250);
      expect((await rows()).some((row) => row.tool === "wire_funds")).toBe(false);
      expect((await rows()).some((row) => row.who === "vendo-sonnet")).toBe(false);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
