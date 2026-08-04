/** Connected accounts in a REAL browser, end to end through the composed
 * umbrella (block-actions design §B, 04-actions §3):
 *
 *   1. in-flow connect card — a Composio call for a user with NO connection
 *      streams a typed connect-required outcome; the shipped VendoThread
 *      renders the inline connect card; clicking Connect opens the broker's
 *      OAuth window, the card polls the connection active, and the thread
 *      retries the call — which now ASKS first, because a connector tool with no
 *      upstream hint is `ungraded` and the guard will not send someone's email on
 *      a guess (risk-grading redesign D1/D3) — and executes on approval;
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

test("in-flow connect card: connect-required → connect → retry asks → approve executes", async ({ page, request }) => {
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

  // The retry does NOT execute on its own any more, and that is the point: this
  // connector tool is `ungraded` — Composio ships no destructive/read hint for
  // it, and nothing else may guess from its name (risk-grading redesign D1/D3) —
  // so the guard asks before the send leaves. The connector seam is where the
  // old behavior read worst: "connect, then it sends itself" is exactly the
  // moment a person should see the recipient.
  const approval = page.getByRole("article", { name: /^Approval for/ });
  await expect(approval).toBeVisible({ timeout: 20_000 });
  await expect(approval).toContainText("Needs your approval");
  // "Not reviewed" is the ungraded chip in the user's words, and the real
  // payload is on the card — not a summary of it.
  await expect(approval).toContainText("Not reviewed");
  await expect(approval).toContainText("ada@example.test");
  await page.screenshot({ path: "e2e/artifacts/connect-card-retry-asks.png", fullPage: false });

  await approval.getByRole("button", { name: "Approve" }).click();

  // Approved: the same call executes through the fresh connection.
  // Scoped to the thread: the approval→toast morph card carries the same text
  // while it flies (a deliberate visual clone) — an unscoped getByText can catch
  // it mid-flight on slow runners and trip strict mode.
  await expect(page.locator(".fl-msglist").getByText("Sent the email.")).toBeVisible({ timeout: 20_000 });
  // 2026-07 chrome wave (lane pick C1) — a succeeded call leaves NO transcript
  // chip: live progress rides the status ribbon above the composer and the
  // mechanical record stays in the Activity panel. The connect card itself
  // settles into a permanent in-transcript "Connected" record.
  await expect(card.getByText("Connected")).toBeVisible({ timeout: 10_000 });
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
