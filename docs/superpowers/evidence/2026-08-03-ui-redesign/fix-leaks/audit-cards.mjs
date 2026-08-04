// The machine audit behind the PNGs in ./cards.
//
// Every captured case is re-opened in the SAME real browser session and the
// CARD's own readable text (the `article` shell plus its accessible names — not
// my figure captions, and not the `title` attribute the consent honesty contract
// keeps the raw value in) is checked against the consumer-voice vocabulary from
// packages/ui/test/chrome/consumer-voice-law.test.tsx: no id-shaped token, no
// code-call syntax, no dotted identifier path, no environment variable, no
// configuration instruction.
//
// Usage (from packages/ui): node ../../docs/superpowers/evidence/2026-08-03-ui-redesign/fix-leaks/audit-cards.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../../../packages/ui");
const requireFromUi = createRequire(join(uiRoot, "package.json"));
const { chromium } = requireFromUi("@playwright/test");

const PORT = 4279;
const BASE = `http://127.0.0.1:${PORT}`;
const LOGO_CDN = "https://logos.composio.dev/**";

const FORBIDDEN = [
  ["an id-shaped token", /\b[a-z]{2,6}_[A-Za-z0-9]{4,}/],
  ["code-call syntax", /\b[A-Za-z_$][\w$]*\(\s*[\w$"'{[]/],
  ["a dotted identifier path", /\b[a-z]{2,}[A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]+)+\b/],
  ["an environment variable", /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/],
  ["a configuration instruction", /pass a |set VENDO_|createVendo\(/],
  ["a model instruction", /\be\.g\.|\bdivide by \d|\bdo not\b|\binteger cents\b/i],
];

/** The positive control: an audit that flags nothing proves nothing, so the
 *  vocabulary is first run against the four strings that WERE on screen. */
const CONTROL = [
  "Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying",
  "connected accounts are not configured: pass a Composio connector (composioConnector) to createVendo({ connectors }) or set VENDO_API_KEY",
  "Update my TopMerchants remix (app app_7f3a2b41): ",
  "editor access is required for app_7c2f19",
];
const controlMisses = CONTROL.filter((text) => !FORBIDDEN.some(([, pattern]) => pattern.test(text)));
if (controlMisses.length > 0) {
  console.error("the audit vocabulary has no teeth for:", controlMisses);
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  "node",
  [join(uiRoot, "node_modules/vite/bin/vite.js"), "--config", "gallery/vite.config.ts",
    "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: uiRoot, stdio: "inherit" },
);

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/`);
      if (response.ok) break;
    } catch {
      await wait(500);
    }
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  await context.route(LOGO_CDN, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) }));
  const page = await context.newPage();
  await page.goto(`${BASE}/#cards`);
  await page.locator("[data-gallery-case]").first().waitFor({ timeout: 20_000 });
  await wait(1_200);

  const cases = await page.locator("[data-gallery-case]").evaluateAll((figures) =>
    figures.map((figure) => {
      const card = figure.querySelector("article") ?? figure;
      const lines = [];
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) lines.push(walker.currentNode.textContent ?? "");
      for (const node of card.querySelectorAll("[aria-label]")) lines.push(node.getAttribute("aria-label") ?? "");
      if (card.hasAttribute("aria-label")) lines.push(card.getAttribute("aria-label") ?? "");
      return { id: figure.getAttribute("data-gallery-case"), text: lines.join("\n") };
    }),
  );

  const report = [];
  let violations = 0;
  for (const item of cases) {
    // A person's own content belongs on their screen: emails and URLs out first.
    const text = item.text.replace(/[\w.+-]+@[\w.-]+|https?:\/\/\S+/g, " ");
    const hits = FORBIDDEN
      .map(([label, pattern]) => [label, pattern.exec(text)])
      .filter(([, hit]) => hit !== null)
      .map(([label, hit]) => `${label}: ${JSON.stringify(hit[0])}`);
    violations += hits.length;
    report.push(`${hits.length === 0 ? "clean" : "LEAK "} ${item.id}${hits.length === 0 ? "" : ` → ${hits.join("; ")}`}`);
  }
  report.sort();
  const summary = `${cases.length} cards audited · ${violations} violations`
    + ` · positive control: all ${CONTROL.length} known-leak strings flagged`;
  writeFileSync(join(here, "audit-cards.txt"), `${report.join("\n")}\n\n${summary}\n`);
  console.log(`${summary}\n${report.join("\n")}`);
  await browser.close();
  if (violations > 0) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
}
