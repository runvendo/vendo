import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { buildJudgePrompt, defaultJudgeModel, fidelityThreshold, parseJudgeVerdict } from "./judge.js";

/**
 * LIVE judge test (criteria 35/36): feed the real vision judge fixture images
 * where the built screen deliberately breaks ONE dimension (palette — a red
 * clone of a violet product) and assert that exact dimension lands below the
 * threshold in the verdict. Needs ANTHROPIC_API_KEY (source flowlet/.env)
 * AND the explicit VENDO_LIVE_TESTS=1 opt-in, so a keyed `pnpm test` never
 * silently spends. ~1 model call, a few cents.
 */

const hasKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY !== ""
  && process.env.VENDO_LIVE_TESTS === "1";

function productPage(options: { accent: string; background: string; text: string }): string {
  return `<!doctype html><html><body style="margin:0;font-family:Inter,system-ui,sans-serif;background:${options.background};color:${options.text}">
  <div style="display:flex;height:100vh">
    <aside style="width:220px;border-right:1px solid #ddd;padding:16px">
      <div style="font-weight:700;font-size:18px;color:${options.accent}">◆ Tracker</div>
      <nav style="margin-top:24px;display:grid;gap:8px;font-size:14px">
        <div>Inbox</div><div>My Issues</div><div>Projects</div><div>Views</div>
      </nav>
    </aside>
    <main style="flex:1;padding:24px">
      <h1 style="font-size:20px">Active issues</h1>
      <button style="background:${options.accent};color:white;border:none;border-radius:8px;padding:8px 14px">New issue</button>
      <table style="margin-top:16px;width:100%;font-size:14px;border-collapse:collapse">
        <tr style="text-align:left;color:#777"><th>Title</th><th>Status</th><th>Assignee</th></tr>
        <tr><td>Fix onboarding drop-off</td><td style="color:${options.accent}">In progress</td><td>Maya R.</td></tr>
        <tr><td>Dark mode for boards</td><td>Backlog</td><td>Jonas K.</td></tr>
      </table>
    </main>
  </div></body></html>`;
}

describe.skipIf(!hasKey)("live judge (fixture images)", () => {
  it("scores a deliberately-wrong palette below the threshold, in the right dimension", { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-judge-live-"));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
      // Evidence: violet brand. Built: same structure, red palette on a dark bg.
      await page.setContent(productPage({ accent: "#5E6AD2", background: "#FFFFFF", text: "#16161D" }));
      const evidencePath = path.join(dir, "evidence.png");
      await page.screenshot({ path: evidencePath });
      await page.setContent(productPage({ accent: "#E11D48", background: "#1A0A0F", text: "#FDE8ED" }));
      const builtPath = path.join(dir, "built.png");
      await page.screenshot({ path: builtPath });

      const verdict = parseJudgeVerdict(await defaultJudgeModel(buildJudgePrompt({ prospect: "Tracker" }), [
        { label: "EVIDENCE operator screenshot (real product UI)", path: evidencePath },
        { label: 'BUILT screen "/"', path: builtPath },
      ]));

      const palette = verdict.scores.find((score) => score.dimension === "palette");
      expect(palette, "palette dimension present").toBeDefined();
      expect(palette?.score ?? 10, `palette must fail (got ${palette?.score}: ${palette?.justification})`).toBeLessThan(fidelityThreshold);
      expect(verdict.failing).toContain("palette");
      // Structure is identical, so layout must NOT be the thing that fails hardest:
      const layout = verdict.scores.find((score) => score.dimension === "layout");
      expect((layout?.score ?? 0) > (palette?.score ?? 0), "layout should outscore the broken palette").toBe(true);
    } finally {
      await browser.close();
    }
  });
});
