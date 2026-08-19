/**
 * THE SEAM: the shipped `useVendoChat` in a real browser against a real
 * `agentHandler()` over real HTTP, with no stub on either side.
 *
 * One script, one run, the whole flow — a turn that parks on a real guard
 * approval, a person answering it in the page, and the parked call actually
 * running. What makes it a seam test rather than a demo is the last assertion:
 * the refund is read back from the SERVER's own record, so a page that merely
 * rendered a convincing sentence cannot pass.
 */
import { expect, test } from "@playwright/test";

test("a parked approval is answered in the page, and the parked call then runs", async ({ page, request }) => {
  await page.goto("/agent.html");
  await expect(page.getByTestId("composer")).toBeVisible();

  // Nothing has run yet: the mount's own record is the baseline.
  expect((await (await request.get("/__agent/refunds")).json() as { refunded: string[] }).refunded).toEqual([]);

  await page.getByTestId("composer").fill("refund invoice 7");
  await page.getByTestId("send").click();

  // 1. The turn reached the agent and came back with the conversation's id on
  //    the response header — the round trip, not a rendered guess.
  await expect(page.getByTestId("thread-id")).toHaveText(/^thr_/);

  // 2. It PARKED. The guard's ask crossed the stream as a real
  //    `approval-requested` part and the hook surfaced it as an interruption,
  //    naming the tool the agent is waiting to run.
  await expect(page.getByTestId("interruption")).toHaveCount(1);
  await expect(page.getByTestId("interruption-tool")).toHaveText("host_refund");
  await page.screenshot({ path: "e2e/artifacts/agent-chat-parked.png", fullPage: true });
  // Still nothing has run — the park is real, not cosmetic.
  expect((await (await request.get("/__agent/refunds")).json() as { refunded: string[] }).refunded).toEqual([]);

  // 3. The person answers, in the page, through the hook's own `resume`.
  await page.getByTestId("approve").click();

  // 4. The parked call RAN — server-side evidence, not screen text.
  await expect(async () => {
    const { refunded } = await (await request.get("/__agent/refunds")).json() as { refunded: string[] };
    expect(refunded).toEqual(["inv_7"]);
  }).toPass({ timeout: 20_000 });

  // 5. And the turn CARRIED ON to its answer, read back through this mount's
  //    own thread route.
  //
  //    WHERE THE LIVE LEG STOPS, precisely: the ai-SDK ends its read of the
  //    response at `tool-approval-request` — by its model a park ends the
  //    request and the client resumes with a new one — so the browser is no
  //    longer listening when the unblocked turn finishes. The turn still runs
  //    to completion and still persists (the refund above is the proof), and
  //    the umbrella covers the live gap with a stream-rejoin route
  //    (`GET /threads/:id/stream`) that this mount does not have. Watching a
  //    parked turn finish without a reload is durable resume, which is
  //    `POST /turns/:id/resume` — wired here, and still a 501 seam.
  const threadId = await page.getByTestId("thread-id").textContent();
  await page.goto(`/agent.html?thread=${threadId ?? ""}`);
  await expect(page.getByTestId("message-assistant").last()).toHaveText(/Refund sent\./);
  await expect(page.getByTestId("interruption")).toHaveCount(0);
  await page.screenshot({ path: "e2e/artifacts/agent-chat-resumed.png", fullPage: true });
});

test("the conversation is read back from the server after a reload, approvals included", async ({ page }) => {
  await page.goto("/agent.html");
  await page.getByTestId("composer").fill("refund invoice 7");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("interruption")).toHaveCount(1);
  const threadId = await page.getByTestId("thread-id").textContent();

  // A FULL reload, with the browser's own stores emptied first: whatever comes
  // back can only have come from the server.
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.sessionStorage.clear();
  });
  await page.goto(`/agent.html?thread=${threadId ?? ""}`);

  // Reopened purely from the server's transcript: the user's message is back,
  // and so is the approval it is still waiting on.
  await expect(page.getByTestId("message-user")).toHaveText("refund invoice 7");
  await expect(page.getByTestId("interruption")).toHaveCount(1);
  await page.screenshot({ path: "e2e/artifacts/agent-chat-reloaded.png", fullPage: true });
});
