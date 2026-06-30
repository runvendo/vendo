import { test, expect } from "@playwright/test";

test("gate ui/update: controller.update() replaces a node by id and new content appears", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=update");
  const frame = page.frameLocator("#flowlet-stage");

  // Wait for initial render.
  await expect(frame.getByRole("heading", { name: "Before" })).toBeVisible();

  // Drive a ui/update to replace the node content.
  await page.evaluate(async () => {
    await (window as any).__controller.update({
      replace: {
        nodeId: "c1",
        node: {
          id: "c1",
          kind: "component",
          source: "host",
          name: "Card",
          props: { title: "After", body: "updated content" },
        },
      },
    });
  });

  // New content must appear; old content must be gone.
  await expect(frame.getByRole("heading", { name: "After" })).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Before" })).not.toBeVisible();
});

test("gate ui/update: action on updated node round-trips through chokepoint", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=action");
  const frame = page.frameLocator("#flowlet-stage");

  // Wait for initial render and verify action works before update.
  await frame.getByTestId("card-btn").click();
  await expect(page.locator("#action-log")).toHaveText("origin=c1 action=confirm result=ok");

  // Drive a ui/update to replace the c1 node — new capability should be minted.
  await page.evaluate(async () => {
    await (window as any).__controller.update({
      replace: {
        nodeId: "c1",
        node: {
          id: "c1",
          kind: "component",
          source: "host",
          name: "Card",
          props: {
            title: "Updated",
            body: "replaced",
            action: { action: "confirm", label: "Confirm", payload: { amount: 99 } },
          },
        },
      },
    });
  });

  // Clear log and click again — must still work with fresh capability.
  await page.evaluate(() => { document.getElementById("action-log")!.textContent = ""; });
  await frame.getByTestId("card-btn").click();
  await expect(page.locator("#action-log")).toHaveText("origin=c1 action=confirm result=ok");
});

test("gate ui/update: replacing an unknown nodeId rejects loudly instead of silent ok", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=update");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByRole("heading", { name: "Before" })).toBeVisible();

  const errMessage = await page.evaluate(async () => {
    try {
      await (window as any).__controller.update({
        replace: {
          nodeId: "does-not-exist",
          node: { id: "does-not-exist", kind: "component", source: "host", name: "Card", props: { title: "X", body: "y" } },
        },
      });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });

  expect(errMessage).toContain("unknown nodeId");
  // The original content must remain untouched.
  await expect(frame.getByRole("heading", { name: "Before" })).toBeVisible();
});
