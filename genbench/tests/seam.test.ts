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
import type { UIPayload } from "@vendoai/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FloorResult } from "../src/floor.js";
import { AUDITOR_CONTRACT } from "../src/audit.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { writePreview } from "../src/report.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { writeCase, type CaseResult } from "../src/run.js";
import { TriageContract } from "../src/triage.js";
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
  honestData: { pass: true, offenders: [], examined: 0 },
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
  triageContract: TriageContract,
  auditorContract: AUDITOR_CONTRACT,
});

const SHOT: Shot = { png: PNG, visibleText: "", renders: true, consoleErrors: [] };

/** Every identity the feed is showing, top row first. */
type Rows = Array<{ who: string; tool: string }>;

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
          })),
        );

      // The honest press, through the real recorder, from the real frame.
      await frame!.evaluate(() => window.vendo.callTool("cancel_transfer", { id: "tr_1" }));
      await expect.poll(rows, { timeout: 10_000 }).toEqual([{ who: "diy-sonnet", tool: "cancel_transfer" }]);

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
        { who: "diy-sonnet", tool: "transfer_money" },
        { who: "diy-sonnet", tool: "cancel_transfer" },
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
