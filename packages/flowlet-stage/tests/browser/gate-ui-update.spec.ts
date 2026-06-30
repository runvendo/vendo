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
      nodeId: "c1",
      node: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "After", body: "updated content" },
      },
    });
  });

  // New content must appear; old content must be gone.
  await expect(frame.getByRole("heading", { name: "After" })).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Before" })).not.toBeVisible();
});
