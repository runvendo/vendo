/** Connected accounts in a REAL browser, end to end through the composed
 * umbrella (block-actions design §B, 04-actions §3):
 *
 *   1. in-flow connect card — a Composio call for a user with NO connection
 *      streams a typed connect-required outcome; the shipped VendoThread
 *      renders the inline connect card; clicking Connect opens the broker's
 *      OAuth window, the card polls the connection active, and the thread
 *      retries the call, which now executes through the connected account;
 *   2. persistent settings panel — the shipped ConnectedAccountsPanel lists
 *      the account and disconnects it over the wire.
 *
 * Screenshots for the PR body land in e2e/artifacts/.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

async function reset(request: APIRequestContext): Promise<void> {
  await expect(async () => {
    const response = await request.post("/__test/reset");
    expect(response.ok()).toBeTruthy();
  }).toPass({ timeout: 30_000 });
}

test("in-flow connect card: connect-required → connect → automatic retry executes", async ({ page, request }) => {
  await reset(request);
  const scripted = await request.post("/__test/script", {
    data: {
      turns: [
        // Turn 1: the model calls the Composio gmail tool; Bob has no connection.
        { kind: "tool", name: "gmail_GMAIL_SEND_EMAIL", input: { to: "ada@example.test" }, toolCallId: "call_send_1" },
        { kind: "text", text: "You need to connect gmail first.", id: "t_connect" },
        // Turn 2 (the retry message): the model re-issues the call; it executes.
        { kind: "tool", name: "gmail_GMAIL_SEND_EMAIL", input: { to: "ada@example.test" }, toolCallId: "call_send_2" },
        { kind: "text", text: "Sent the email.", id: "t_sent" },
      ],
    },
  });
  expect(scripted.ok()).toBeTruthy();

  await page.goto("/?user=user_bob&thread=thr_connect");
  const composer = page.getByRole("textbox", { name: /message/i });
  await expect(composer).toBeVisible();

  await composer.fill("Email Ada the report");
  await composer.press("Enter");

  // The typed outcome renders the inline connect card beside the tool part.
  const card = page.getByRole("article", { name: "Connect gmail" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Connect your gmail account");
  await page.screenshot({ path: "e2e/artifacts/connect-card-in-flow.png", fullPage: false });

  // Connect: the broker window opens; the card polls to active and retries.
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => undefined);
  await card.getByRole("button", { name: "Connect gmail" }).click();
  const popup = await popupPromise;
  await popup?.close().catch(() => undefined);

  // The retry executed the REAL connector call through the fresh connection.
  await expect(page.getByText("Sent the email.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Tool: gmail_GMAIL_SEND_EMAIL/i).last()).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/connect-card-retried.png", fullPage: false });
});

test("settings panel lists the connected account and disconnects it", async ({ page, request }) => {
  await reset(request);
  // user_ada is seeded with an active gmail connection in the broker stub.
  await page.goto("/?user=user_ada&thread=thr_accounts");

  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Disconnect gmail" })).toBeVisible();
  await expect(panel.getByText(/Connected · since/)).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/artifacts/connected-accounts-panel.png", fullPage: true });

  await panel.getByRole("button", { name: "Disconnect gmail" }).click();
  await expect(panel.getByText(/No connected accounts yet/)).toBeVisible();
  await expect(panel.getByText(/Connected · since/)).toBeHidden();
  await page.screenshot({ path: "e2e/artifacts/connected-accounts-disconnected.png", fullPage: true });
});
