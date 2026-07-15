import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromUi = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { chromium } = requireFromUi("@playwright/test");
const evidenceDir = dirname(fileURLToPath(import.meta.url));

const firstPrompt = "My name is Farouk and I bank here for my bakery.";
const secondPrompt = "What is my name?";
const threadHeader = "x-vendo-thread-id";

const demos = [
  {
    name: "Maple",
    slug: "maple",
    url: "http://localhost:3020/vendo",
    origin: "http://localhost:3020",
  },
  {
    name: "Cadence",
    slug: "cadence",
    url: "http://localhost:3010/assistant",
    origin: "http://localhost:3010",
  },
];

function isThreadPost(request) {
  return request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/vendo/threads");
}

async function waitUntilReady(page) {
  const ready = () => {
    const status = document.querySelector('form[aria-label="Message composer"] [role="status"]');
    const input = document.querySelector('textarea[aria-label="Message"]');
    return status?.textContent?.trim() === "ready" && input instanceof HTMLTextAreaElement && !input.disabled;
  };
  try {
    await page.waitForFunction(ready, undefined, { timeout: 15_000 });
    return false;
  } catch (reason) {
    const status = (await page.locator('form[aria-label="Message composer"] [role="status"]').textContent())?.trim();
    const stop = page.getByRole("button", { name: "Stop" });
    if (!["submitted", "streaming"].includes(status ?? "") || !(await stop.isVisible())) throw reason;
    await stop.click();
    await page.waitForFunction(ready, undefined, { timeout: 15_000 });
    return true;
  }
}

async function sendTurn(page, prompt) {
  const input = page.getByRole("textbox", { name: "Message" });
  await input.pressSequentially(prompt, { delay: 5 });
  const send = page.locator('form[aria-label="Message composer"] button[aria-label="Send"]');
  const [response] = await Promise.all([
    page.waitForResponse(
      response => isThreadPost(response.request()),
      { timeout: 120_000 },
    ),
    send.click(),
  ]);
  const request = response.request();
  assert.equal(response.status(), 200, `thread POST failed: ${response.status()} ${response.statusText()}`);
  await response.finished();
  const neededStop = await waitUntilReady(page);

  const body = request.postDataJSON();
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  return {
    body,
    returnedThreadId: response.headers()[threadHeader],
    neededStop,
  };
}

async function verifyDemo(browser, demo) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", error => browserErrors.push(`page: ${error.message}`));
  try {
    await page.goto(demo.url, { waitUntil: "load", timeout: 120_000 });
    await page.getByRole("textbox", { name: "Message" }).waitFor({ state: "visible", timeout: 120_000 });
    await waitUntilReady(page);

    const first = await sendTurn(page, firstPrompt);
    assert.equal(
      Object.prototype.hasOwnProperty.call(first.body, "threadId"),
      false,
      `${demo.name} turn 1 unexpectedly sent threadId`,
    );
    assert.match(first.returnedThreadId ?? "", /^thr_.+$/, `${demo.name} turn 1 did not return a minted thread id`);
    await page.screenshot({
      path: resolve(evidenceDir, `${demo.slug}-turn-1.png`),
      fullPage: true,
    });

    const second = await sendTurn(page, secondPrompt);
    assert.equal(
      second.body.threadId,
      first.returnedThreadId,
      `${demo.name} turn 2 did not reuse the minted thread id`,
    );
    assert.equal(second.returnedThreadId, first.returnedThreadId, `${demo.name} server changed thread ids on turn 2`);

    const assistantMessages = page.locator('article[data-role="assistant"]');
    assert.equal(await assistantMessages.count(), 2, `${demo.name} did not render two assistant turns`);
    const secondAnswer = (await assistantMessages.nth(1).innerText()).trim();
    assert.match(secondAnswer, /Farouk/i, `${demo.name} turn 2 did not remember Farouk`);

    const storedResponse = await context.request.get(
      `${demo.origin}/api/vendo/threads/${encodeURIComponent(first.returnedThreadId)}`,
    );
    assert.equal(storedResponse.status(), 200, `${demo.name} persisted thread lookup failed`);
    const storedThread = await storedResponse.json();
    assert.equal(storedThread.id, first.returnedThreadId, `${demo.name} persisted a different thread id`);
    assert.equal(storedThread.messages.length, 4, `${demo.name} did not persist four messages on one thread`);
    assert.deepEqual(browserErrors, [], `${demo.name} logged browser errors: ${browserErrors.join("\n")}`);

    await page.screenshot({
      path: resolve(evidenceDir, `${demo.slug}-turn-2.png`),
      fullPage: true,
    });

    return {
      demo: demo.name,
      threadId: first.returnedThreadId,
      turn1RequestHasThreadId: Object.prototype.hasOwnProperty.call(first.body, "threadId"),
      turn1ResponseThreadId: first.returnedThreadId,
      turn2RequestThreadId: second.body.threadId,
      turn2ResponseThreadId: second.returnedThreadId,
      composerStopAfterTurn1: first.neededStop,
      composerStopAfterTurn2: second.neededStop,
      persistedMessageCount: storedThread.messages.length,
      turn2Answer: secondAnswer,
    };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const demo of demos) results.push(await verifyDemo(browser, demo));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
