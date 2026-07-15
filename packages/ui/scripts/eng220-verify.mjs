// ENG-220 browser verification: launcher positioning, ⌘K/programmatic open,
// portal to body, scroll-lock + inert, focus correctness on both demo hosts.
// Maple: launcher="none" (dock + ⌘K-only host) — proves programmatic entry and
// invoker focus restore. Cadence: default fixed bottom-right launcher.
// Run: node packages/ui/scripts/eng220-verify.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = new URL("../../../docs/verification/eng-220/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const overlayState = () => ({
  dialog: !!document.querySelector('[role="dialog"][aria-label="Vendo assistant"]'),
  portalParentIsBody: document.querySelector(".fl-overlay-portal")?.parentElement === document.body,
  bodyOverflow: document.body.style.overflow,
  inertCount: [...document.body.children].filter(el => el.hasAttribute("inert")).length,
  portalInert: !!document.querySelector(".fl-overlay-portal[inert]"),
  active: document.activeElement ? {
    tag: document.activeElement.tagName,
    insideDialog: !!document.activeElement.closest('[role="dialog"]'),
  } : null,
});

async function expectOpenInvariants(page, name) {
  await page.waitForSelector('[role="dialog"][aria-label="Vendo assistant"]', { timeout: 10_000 });
  const s = await page.evaluate(overlayState);
  check(`${name}: overlay open`, s.dialog);
  check(`${name}: panel portaled to <body>`, s.portalParentIsBody);
  check(`${name}: body scroll locked`, s.bodyOverflow === "hidden");
  check(`${name}: background inert (portal itself not inert)`, s.inertCount > 0 && !s.portalInert, `inert siblings=${s.inertCount}`);
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  const f = await page.evaluate(overlayState);
  check(`${name}: focus lands in composer`, f.active?.tag === "TEXTAREA" && f.active.insideDialog);
}

async function expectClosedInvariants(page, name, how) {
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Vendo assistant"]'));
  const s = await page.evaluate(overlayState);
  check(`${name}: ${how} closes + scroll/inert cleaned`, !s.dialog && s.bodyOverflow === "" && s.inertCount === 0);
}

const CMDK = process.platform === "darwin" ? "Meta+k" : "Control+k";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// ---------- Maple (:3200) — launcher="none", ⌘K-only, invoker restore ----------
await page.goto("http://localhost:3200/", { waitUntil: "networkidle" });
check("Maple: no built-in launcher (launcher=\"none\")", await page.evaluate(() => !document.querySelector(".fl-launcher")));
await page.screenshot({ path: `${OUT}03-after-maple-no-stray-launcher.png` });

// Focus a real host control so restore has an invoking element to return to.
const invoker = page.locator("a[href], button").first();
await invoker.focus();
await page.keyboard.press(CMDK);
await expectOpenInvariants(page, "Maple");
await page.waitForTimeout(800); // let the entrance animation settle for the evidence shot
await page.screenshot({ path: `${OUT}04-after-maple-open-focused.png` });

await page.keyboard.press("Escape");
await expectClosedInvariants(page, "Maple", "Escape");
check("Maple: focus restored to invoking element (not body)",
  await page.evaluate(() => document.activeElement !== document.body && !!document.activeElement));
const activeTag = await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className}`.slice(0, 60));
console.log(`  (restored focus target: ${activeTag})`);

// ⌘K toggles closed too (programmatic close path through the host hook).
await page.keyboard.press(CMDK);
await page.waitForSelector('[role="dialog"][aria-label="Vendo assistant"]');
await page.keyboard.press(CMDK);
await expectClosedInvariants(page, "Maple", "⌘K toggle");
await page.screenshot({ path: `${OUT}05-after-maple-closed-restored.png` });

// ---------- Cadence (:3210) — default positioned launcher ----------
await page.goto("http://localhost:3210/", { waitUntil: "networkidle" });
await page.waitForSelector(".fl-launcher", { state: "visible", timeout: 20_000 });
const l = await page.evaluate(() => {
  const el = document.querySelector(".fl-launcher");
  const r = el.getBoundingClientRect();
  return { position: getComputedStyle(el).position, variant: el.getAttribute("data-vendo-launcher"),
    right: innerWidth - Math.round(r.x + r.width), bottom: innerHeight - Math.round(r.y + r.height),
    w: Math.round(r.width), h: Math.round(r.height) };
});
check("Cadence: launcher fixed bottom-right", l.position === "fixed" && l.variant === "bottom-right"
  && l.right >= 10 && l.right <= 40 && l.bottom >= 10 && l.bottom <= 40, JSON.stringify(l));
await page.screenshot({ path: `${OUT}06-after-cadence-launcher.png` });

await page.keyboard.press(CMDK);
await expectOpenInvariants(page, "Cadence");
await page.waitForTimeout(800); // let the entrance animation settle for the evidence shot
await page.screenshot({ path: `${OUT}07-after-cadence-open-focused.png` });

await page.keyboard.press("Escape");
await expectClosedInvariants(page, "Cadence", "Escape");
check("Cadence: ⌘K restore falls back to visible launcher",
  await page.evaluate(() => document.activeElement?.classList.contains("fl-launcher")));

// Launcher click open + scrim click close + launcher restore.
await page.click(".fl-launcher");
await expectOpenInvariants(page, "Cadence(click)");
await page.mouse.click(40, 450); // scrim, far left of the centered panel
await expectClosedInvariants(page, "Cadence(click)", "scrim click");
check("Cadence: focus restored to launcher after scrim close",
  await page.evaluate(() => document.activeElement?.classList.contains("fl-launcher")));
await page.screenshot({ path: `${OUT}08-after-cadence-closed-restored.png` });

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
