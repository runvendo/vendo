/** J7 — UI HOOKS IN A REAL BROWSER, end to end through the composed umbrella.
 *
 * The shipped `VendoRoot` + `<VendoThread />` chrome and a `useApps` probe drive
 * the REAL `createVendo` wire (proxied same-origin) against the booted fixture
 * host app. One deterministic journey, no live keys:
 *
 *   1. send a chat message → the scripted assistant text streams and renders;
 *   2. send a destructive-tool turn → the composed destructive-ask policy parks
 *      it → the approval surfaces in-thread → click Approve → the resume executes
 *      the REAL host DELETE (asserted by polling the host API) and the thread
 *      shows completion;
 *   3. the `useApps` surface lists the app a scripted generation turn produced.
 *
 * This is the first time the shipped hooks/chrome talk to the actual composed
 * wire (every other browser suite runs against a hand-built wire fixture) — a
 * hooks-vs-wire mismatch would surface right here.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

const INVOICE = "inv_0003"; // ADA's seeded draft invoice
const CREATE_DIALECT = `<App name="Ada's Greeting"><Text text="Hello Ada"/></App>`;

async function script(request: APIRequestContext): Promise<void> {
  await expect(async () => {
    const reset = await request.post("/__test/reset");
    expect(reset.ok()).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  const scripted = await request.post("/__test/script", {
    data: {
      turns: [
        { kind: "text", text: "Hi Ada, I'm ready to help.", id: "t_greet" },
        { kind: "tool", name: "host_invoices_delete", input: { id: INVOICE }, toolCallId: "call_del" },
        { kind: "text", text: "Deleted the invoice.", id: "t_done" },
        // Two-lane create (v2 spec §4): paint + full lane each consume a turn.
        { kind: "generate", dialect: CREATE_DIALECT },
        { kind: "generate", dialect: CREATE_DIALECT, id: "gen_2" },
      ],
    },
  });
  expect(scripted.ok()).toBeTruthy();
}

test("J7: chat streams, destructive approval executes for real, useApps lists the generated app", async ({ page, request }) => {
  await script(request);
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: /message/i });
  await expect(composer).toBeVisible();

  // --- 1. chat send → streamed assistant text renders ----------------------
  await composer.fill("Hello");
  await composer.press("Enter");
  await expect(page.getByText("Hi Ada, I'm ready to help.")).toBeVisible();

  // --- 2. destructive tool turn → in-thread approval parks -----------------
  await expect(composer).toBeEnabled();
  await composer.fill(`Delete invoice ${INVOICE}`);
  await composer.press("Enter");

  // ENG-216 — the approval card aria-label carries the humanized title
  // (humanizeToolName("host_invoices_delete") → "Invoices delete"), not the raw slug.
  const approval = page.getByRole("article", { name: /Approval for Invoices delete/i });
  await expect(approval).toBeVisible();
  // The parked destructive call must NOT have executed yet.
  await expect
    .poll(async () => (await (await request.get(`/__test/host/invoice/${INVOICE}`)).json()).exists)
    .toBe(true);

  // Approve in-page → the resume executes the REAL host DELETE.
  await approval.getByRole("button", { name: "Approve" }).click();

  // UI reflects completion...
  await expect(page.getByText("Deleted the invoice.")).toBeVisible();
  // ENG-216 — chip shows the humanized tool label, never the raw slug / "Tool:" prefix.
  await expect(page.getByText("Invoices delete").last()).toBeVisible({ timeout: 10_000 });
  // ...and the REAL side effect landed on the host app.
  await expect
    .poll(async () => (await (await request.get(`/__test/host/invoice/${INVOICE}`)).json()).exists, {
      timeout: 15_000,
    })
    .toBe(false);

  // --- 3. useApps lists the app the generation turn produced ---------------
  await page.getByTestId("apps-create").click();
  const list = page.getByTestId("apps-list");
  await expect(list.getByText("Ada's Greeting")).toBeVisible();
});
