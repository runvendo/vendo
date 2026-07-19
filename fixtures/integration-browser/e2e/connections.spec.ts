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
  // ENG-216 — the chip renders the humanized tool label (host metadata absent →
  // humanizeToolName("gmail_GMAIL_SEND_EMAIL")), never the raw slug or "Tool:" prefix.
  await expect(page.getByText("Gmail send email").last()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "e2e/artifacts/connect-card-retried.png", fullPage: false });
});

test("settings panel lists the connected account and severs it through confirm + undo window", async ({ page, request }) => {
  await reset(request);
  // user_ada is seeded with an active gmail connection in the broker stub.
  await page.goto("/?user=user_ada&thread=thr_accounts");

  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  // ui-lane-panels pick A — identity-forward rows: display name (never the raw
  // slug), a status chip, and the connector demoted to a byline.
  await expect(panel.getByText("Gmail").first()).toBeVisible();
  await expect(panel.getByText(/via Composio · connected/)).toBeVisible();
  const disconnect = panel.getByRole("button", { name: "Disconnect Gmail" });
  await expect(disconnect).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/artifacts/connected-accounts-panel.png", fullPage: true });

  // ui-lane-panels pick D — severing is a two-step ceremony. Step 1 expands
  // the inline consequence confirm (no wire call yet).
  await disconnect.click();
  await expect(disconnect).toHaveAttribute("aria-expanded", "true");

  // Step 2 collapses the card into a severed row with a live undo window; the
  // wire DELETE is deferred until the window lapses.
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel.getByText(/Gmail disconnected/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/connected-accounts-undo-window.png", fullPage: true });

  // The 10s undo window lapses → the disconnect commits over the wire and the
  // connect-ahead empty state (pick F) takes the panel.
  await expect(panel.getByText(/No connected accounts yet/)).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(/via Composio · connected/)).toBeHidden();
  await page.screenshot({ path: "e2e/artifacts/connected-accounts-disconnected.png", fullPage: true });
});
