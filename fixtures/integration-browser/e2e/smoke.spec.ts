/** A minimal smoke: the shipped Vendo React surface mounts against the composed
 *  wire and renders its chrome. Breadth belongs to the node suite — this only
 *  guards that the page boots and the wire actually round-trips same-origin. */
import { expect, test } from "@playwright/test";

test("the Vendo React surface mounts and reaches the composed wire", async ({ page, request }) => {
  await page.goto("/");
  // The thread chrome rendered its composer (empty-thread landing).
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  // The useApps probe mounted its create control.
  await expect(page.getByTestId("apps-probe")).toBeVisible();
  await expect(page.getByTestId("apps-create")).toBeVisible();

  // Prove the WIRE round-tripped, not just that static JSX rendered: hit the same
  // GET /apps the useApps hook drives (proxied same-origin to the composed
  // umbrella, principal via the test-user header) and assert a REAL response —
  // the composed server answered with the app list array (empty for a fresh
  // owner). A dead/unreachable wire would 404/500 or fail to parse here.
  const listed = await request.get("/api/vendo/apps", { headers: { "x-vendo-test-user": "user_ada" } });
  expect(listed.ok()).toBeTruthy();
  expect(Array.isArray(await listed.json())).toBe(true);
});
