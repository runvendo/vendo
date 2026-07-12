import { test } from "@playwright/test";
import { openScenario } from "./helpers.js";
test.use({ reducedMotion: "reduce" });
test("probe stage", async ({ page }) => {
  await openScenario(page, "stage");
  const info = await page.evaluate(() => {
    const chain = (el: Element | null) => {
      const out: string[] = [];
      let n: Element | null = el;
      while (n && out.length < 6) {
        const cs = getComputedStyle(n as HTMLElement);
        out.push(`${(n as HTMLElement).className || n.tagName}:op=${cs.opacity}`);
        n = n.parentElement;
      }
      return out;
    };
    const btn = document.querySelector(".fl-voice-stage button") as HTMLElement | null;
    const status = document.querySelector(".fl-voice-status") as HTMLElement | null;
    const root = status?.closest(".vendo-root") as HTMLElement | null;
    return {
      btnText: btn?.textContent,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : "none",
      btnClass: btn?.className,
      btnChainOpacity: chain(btn),
      statusColor: status ? getComputedStyle(status).color : "none",
      statusInsideRoot: !!root,
      rootMuted: root ? getComputedStyle(root).getPropertyValue("--vendo-fg-muted") : "no root",
    };
  });
  console.log("PROBE " + JSON.stringify(info, null, 1));
});
