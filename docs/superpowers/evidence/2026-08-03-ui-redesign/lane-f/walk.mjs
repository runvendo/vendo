/**
 * Lane F proof: the AI center, walked in a real browser on demo-bank (Maple).
 *
 * Two passes — desktop (1440×900) and phone (390×844) — recorded to video and
 * converted to a GIF, with a still at every station. The walk is: the day-zero
 * ghost shelf → the live shelf → a conversation off the rail → Apps →
 * Automations → the ··· panels → Needs-you appearing and then retiring.
 *
 * THREE wire responses are stubbed, because raising them for real needs a turn
 * and generation is broken on this branch (pre-existing):
 *   GET /apps      → [] for the cold-start station only (Maple's user has four)
 *   GET /threads   → three summaries at different ages (this user has none yet)
 *   GET /approvals → one ask, then none, to show Needs-you arrive and retire
 * Everything rendering them is the shipped component reading the shipped
 * transport; nothing about the center itself is faked.
 *
 *   node walk.mjs            # both passes, expects Maple on :3215
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Playwright is a devDependency of packages/ui, and this script lives under
// docs/ — resolve it from there rather than depending on the cwd.
const { chromium } = createRequire(join(HERE, "../../../../../packages/ui/package.json"))("@playwright/test");

const BASE = process.env.MAPLE_URL ?? "http://localhost:3215/maple";
const EMAIL = process.env.MAPLE_EMAIL ?? "yousef@maple.com";
const PASSWORD = process.env.MAPLE_PASSWORD ?? "maple-demo";

const DAY = 86_400_000;
const ago = ms => new Date(Date.now() - ms).toISOString();

const THREADS = [
  { id: "thr_walk_1", title: "Where did July go?", updatedAt: ago(2 * 3_600_000) },
  { id: "thr_walk_2", title: "Build me a weekly spending summary I can pin", updatedAt: ago(3 * DAY) },
  { id: "thr_walk_3", title: "Move $200 to savings every payday", updatedAt: ago(40 * DAY) },
];

const threadDoc = id => ({
  id,
  subject: "vendo-demo",
  createdAt: ago(2 * 3_600_000),
  updatedAt: ago(2 * 3_600_000),
  messages: [
    { id: "m1", role: "user", parts: [{ type: "text", text: "Where did July go?" }] },
    {
      id: "m2",
      role: "assistant",
      parts: [{
        type: "text",
        text: "July came to $3,947.82 — groceries and rent carried most of it. The breakdown is on your shelf as **Spending This Month**.",
      }],
    },
  ],
});

const ASK = [{
  id: "apr_proof_1",
  call: { id: "call_proof_1", tool: "host_transfers_send", args: { to: "Ada Lovelace", amount: 4200 } },
  descriptor: { name: "host_transfers_send", description: "Send a transfer", inputSchema: { type: "object" }, risk: "write" },
  inputPreview: "$42.00 to Ada Lovelace",
  ctx: { principal: { kind: "user", subject: "vendo-demo" }, venue: "chat", presence: "present" },
  createdAt: ago(90_000),
}];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function walk({ name, width, height, mobile }) {
  const videoDir = join(HERE, `.video-${name}`);
  rmSync(videoDir, { recursive: true, force: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: { width, height } },
  });
  // Cold start is a STATION, not the whole walk: the apps list reads empty until
  // the ghosts have been seen, then Maple's real four come back.
  const state = { apps: "empty", waiting: false };
  await context.route("**/api/vendo/apps", async route => {
    if (route.request().method() !== "GET" || state.apps !== "empty") return route.fallback();
    await json(route, []);
  });
  await context.route("**/api/vendo/threads", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await json(route, THREADS);
  });
  await context.route("**/api/vendo/threads/thr_walk_*", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await json(route, threadDoc(new URL(route.request().url()).pathname.split("/").pop()));
  });
  await context.route("**/api/vendo/approvals", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await json(route, state.waiting ? ASK : []);
  });

  const page = await context.newPage();
  const shot = label => page.screenshot({ path: join(HERE, `${name}-${label}.png`) });
  const newChat = () => (mobile
    ? page.getByRole("button", { name: "New", exact: true })
    : page.getByRole("tab", { name: "New chat", exact: true }));
  const door = label => (mobile
    ? page.getByRole("button", { name: label, exact: true })
    : page.getByRole("tab", { name: label, exact: true }));

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
  await page.waitForURL(url => !url.pathname.endsWith("/login"), { timeout: 30_000 });

  // ---- 1. day zero: the ghost shelf (§14 CS2) ----
  await page.goto(`${BASE}/vendo/workspace`, { waitUntil: "domcontentloaded" });
  await page.locator(".fl-center").first().waitFor({ timeout: 30_000 });
  // Wait for the column to be live (hydrated) before driving the rail: a click
  // that lands pre-hydration is swallowed, and the auto-select then snaps to the
  // newest conversation instead of the home.
  await page.locator(".fl-composer textarea").first().waitFor({ timeout: 30_000 });
  await sleep(1_500);
  await newChat().click();
  await page.locator(".fl-shelf--ghost").waitFor({ timeout: 20_000 });
  await sleep(2_000);
  await shot("1-cold-start");

  // ---- 2. the Apps door, now that apps exist ----
  state.apps = "real";
  await door("Apps").click();
  await sleep(6_000); // the tiles are real apps, really opening
  await shot("2-apps");

  // ---- 3. back on the home: the ghosts have retired for good ----
  await newChat().click();
  await page.locator(".fl-shelf").waitFor({ timeout: 30_000 });
  await sleep(6_000);
  await shot("3-home-live");

  // ---- 4. a conversation off the rail ----
  if (mobile) {
    await page.getByRole("button", { name: "Chats" }).click();
    await sleep(1_400);
    await shot("4-chats-sheet");
    await page.locator(".fl-center-sheet .fl-rail-chat:not(.fl-rail-need)").first().click();
  } else {
    await page.locator(".fl-rail-chat:not(.fl-rail-need)").first().click();
  }
  await sleep(3_000);
  await shot("5-conversation");

  // ---- 5. the other named door ----
  await door("Automations").click();
  await sleep(2_500);
  await shot("6-automations");

  // ---- 6. the quiet ··· panels (the sheet, on mobile) ----
  if (mobile) {
    await page.getByRole("button", { name: "Chats" }).click();
    await sleep(1_200);
    await page.locator(".fl-center-sheet").getByRole("button", { name: "Activity" }).click();
  } else {
    await page.getByRole("button", { name: "More sections" }).click();
    await sleep(700);
    await page.getByRole("tab", { name: "Activity" }).click();
  }
  await sleep(2_500);
  await shot("7-activity");

  // ---- 7. Needs-you: it exists ONLY while an ask waits ----
  await newChat().click();
  await sleep(2_500);
  state.waiting = true;
  await page.locator(".fl-rail-badge").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  if (mobile) {
    await page.getByRole("button", { name: "Chats" }).click();
    await sleep(1_200);
  }
  await sleep(1_500);
  await shot("8-needs-you");
  state.waiting = false;
  await page.locator(".fl-rail-badge").first().waitFor({ state: "detached", timeout: 20_000 }).catch(() => undefined);
  await sleep(1_500);
  await shot("9-needs-you-settled");

  await context.close();
  await browser.close();

  const [file] = readdirSync(videoDir).filter(entry => entry.endsWith(".webm"));
  const webm = join(HERE, `${name}.webm`);
  renameSync(join(videoDir, file), webm);
  rmSync(videoDir, { recursive: true, force: true });
  const gif = join(HERE, `${name}.gif`);
  const scale = mobile ? 390 : 880;
  const result = spawnSync("ffmpeg", [
    "-y", "-i", webm,
    "-vf", `fps=8,scale=${scale}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    "-loop", "0", gif,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.slice(-600)}`);
  rmSync(webm);
  console.log(`[lane-f] ${name}: ${gif}`);
}

mkdirSync(HERE, { recursive: true });
await walk({ name: "desktop", width: 1440, height: 900, mobile: false });
await walk({ name: "mobile", width: 390, height: 844, mobile: true });
