import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

/**
 * The final self-gate of `demo:pipeline` — after deploy, the pipeline itself
 * drives the DEPLOYED demo end-to-end (criterion 37): wait for the Railway
 * service to come up (`railway up --detach` returns long before the build
 * finishes), log in if the demo has a login wall (template clones ship
 * without one — the helper no-ops, same as demo-capture's sign-in), assert
 * the beat suggestion cards render on the /vendo landing, click the
 * generate-ui beat and wait for a real generated view to paint, and
 * screenshot every step. Any failure = the run is NOT done.
 */

export interface GateBeat {
  key: string;
  prompt: string;
  chip: string;
  expectsView?: boolean;
}

/** The beat the gate runs live: the declared generate-ui beat (first with
 * expectsView), else the first beat. */
export function pickGenerationBeat(beats: readonly GateBeat[]): GateBeat {
  const declared = beats.find((beat) => beat.expectsView === true);
  const beat = declared ?? beats[0];
  if (beat === undefined) throw new Error("demo.config.json has no beats — nothing for the final gate to drive");
  return beat;
}

/** Polls the deployed URL until it serves the app with HTTP 200. Railway
 * build+deploy takes ~5-10 minutes after `up --detach`, during which the
 * service domain answers 404 "Application not found" — anything but a clean
 * 200 means not ready (a <500 check once let the gate run against a
 * still-building service). Default budget is 15 minutes. */
export async function waitForDeployedReady(url: string, options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
  onPoll?: (status: string) => void;
} = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const pollMs = options.pollMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    options.onPoll?.(last);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Deployed demo never came up at ${url} within ${Math.round(timeoutMs / 60000)} min (last: ${last})`);
}

export interface GateStep {
  step: string;
  ok: boolean;
  detail: string;
  screenshot?: string;
}

/** RESEARCH/GATE.md — the step-by-step evidence of the deployed-demo drive. */
export function renderGateReport(options: { demoUrl: string; steps: GateStep[] }): string {
  const allOk = options.steps.every((step) => step.ok);
  return `# Final self-gate — ${options.demoUrl}

Verdict: ${allOk ? "**PASS** — login, scenario cards, and one live generation verified on the deployed demo." : "**FAIL** — the run is NOT done."}

| Step | OK | Detail | Screenshot |
| --- | --- | --- | --- |
${options.steps.map((step) => `| ${step.step} | ${step.ok ? "yes" : "NO"} | ${step.detail} | ${step.screenshot === undefined ? "—" : path.basename(step.screenshot)} |`).join("\n")}
`;
}

export interface FinalGateArgs {
  /** The demo's public URL (demos.vendo.run/<id> — followed through the router 302). */
  demoUrl: string;
  appDir: string;
  /** Absolute dir for step screenshots + GATE.md. */
  outDir: string;
}

export interface FinalGateIo {
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface FinalGateResult {
  steps: GateStep[];
  reportPath: string;
}

/** How long one live generation may take on the deployed demo (cold Next.js
 * route + a real multi-turn agent generation). */
const generationTimeoutMs = 5 * 60 * 1000;

export async function runFinalGate(args: FinalGateArgs, io: FinalGateIo = {}): Promise<FinalGateResult> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  await mkdir(args.outDir, { recursive: true });
  const steps: GateStep[] = [];
  const reportPath = path.join(args.outDir, "GATE.md");

  const beats = (JSON.parse(await readFile(path.join(args.appDir, "demo.config.json"), "utf8")) as { beats: GateBeat[] }).beats;
  const generationBeat = pickGenerationBeat(beats);

  const record = async (step: string, ok: boolean, detail: string, screenshot?: string): Promise<void> => {
    steps.push({ step, ok, detail, ...(screenshot === undefined ? {} : { screenshot }) });
    write(`[gate] ${step}: ${ok ? "ok" : "FAIL"} — ${detail}`);
    await writeFile(reportPath, renderGateReport({ demoUrl: args.demoUrl, steps }));
    if (!ok) throw new Error(`Final gate failed at "${step}": ${detail} — evidence in ${args.outDir}`);
  };

  // (1) Service up (Railway build finishes minutes after deploy returns).
  await waitForDeployedReady(args.demoUrl, {
    ...(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl }),
    onPoll: (status) => write(`[gate] waiting for ${args.demoUrl} (${status})`),
  });
  await record("service-up", true, `${args.demoUrl} serves HTTP`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // (2) Open through the router (follows the demos.vendo.run 302).
    await page.goto(args.demoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const productShot = path.join(args.outDir, "gate-1-product.png");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.screenshot({ path: productShot });
    await record("open", true, `landed on ${page.url()}`, productShot);

    // (3) Login — template clones ship without a wall; the helper no-ops
    // (same contract as demo-capture's sign-in). A wall without a password
    // in the environment is a hard fail, not a skip.
    const loginForm = page.locator('form[action="/login"]');
    if (await loginForm.count() > 0) {
      const password = env.DEMO_GATE_PASSWORD ?? "";
      if (password === "") {
        await record("login", false, "the deployed demo has a login wall but DEMO_GATE_PASSWORD is not set");
      }
      await loginForm.locator('input[name="password"]').fill(password);
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForLoadState("domcontentloaded");
      await record("login", true, "login form submitted with the demo password");
    } else {
      await record("login", true, "no login wall (template demos ship without one)");
    }

    // (4) The /vendo panel: badge chrome + every beat's suggestion card.
    const panelUrl = new URL("/vendo", page.url()).toString();
    await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const panelShot = path.join(args.outDir, "gate-2-panel.png");
    await page.screenshot({ path: panelShot });
    const missingChips: string[] = [];
    for (const beat of beats) {
      if (await page.getByText(beat.chip, { exact: false }).count() === 0
        && await page.getByText(beat.prompt, { exact: false }).count() === 0) {
        missingChips.push(beat.key);
      }
    }
    await record(
      "scenario-cards",
      missingChips.length === 0,
      missingChips.length === 0 ? `all ${beats.length} beat cards render` : `missing beat cards: ${missingChips.join(", ")}`,
      panelShot,
    );

    // (5) One live generation, driven through the composer (the same proven
    // path the demo-beats capture uses — landing-suggestion text is not
    // reliably matchable in the DOM). Post-turn re-renders can clear a
    // just-filled composer, so re-fill until Send arms.
    const composer = page.locator('form[aria-label="Message composer"]');
    const messageBox = composer.getByRole("textbox", { name: "Message" });
    await messageBox.waitFor({ state: "visible", timeout: 30_000 });
    const sendButton = composer.getByRole("button", { name: "Send", exact: true });
    const armDeadline = Date.now() + 60_000;
    await messageBox.fill(generationBeat.prompt);
    while (!(await sendButton.isEnabled().catch(() => false))) {
      if (Date.now() > armDeadline) {
        await record("generation-sent", false, "the composer's Send button never armed");
      }
      await page.waitForTimeout(500);
      await messageBox.fill(generationBeat.prompt);
    }
    await sendButton.click();
    const sentShot = path.join(args.outDir, "gate-3-sent.png");
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: sentShot });
    await record("generation-sent", true, `sent the "${generationBeat.key}" beat prompt through the composer`, sentShot);

    await page.locator("[data-vendo-node-id]").first().waitFor({ state: "attached", timeout: generationTimeoutMs });
    // Completion, not just first paint: the turn settles when the composer is
    // idle again and no busy/thinking indicators remain (same markers the
    // demo-beats capture keys on).
    const settleDeadline = Date.now() + generationTimeoutMs;
    for (;;) {
      const idle = await messageBox.isEnabled().catch(() => false);
      const busy = !idle
        || await page.locator('.fl-msglist[aria-busy="true"], .fl-thinking, .fl-act-pulse').count() > 0;
      if (!busy) break;
      if (Date.now() > settleDeadline) {
        await record("generation-complete", false, "the generation never settled (composer stayed busy)");
      }
      await page.waitForTimeout(500);
    }
    const viewShot = path.join(args.outDir, "gate-4-generated.png");
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: viewShot });
    await record("generation-complete", true, "a generated Vendo view painted and the turn settled", viewShot);
  } catch (error) {
    // Give failures a terminal screenshot + report row before rethrowing.
    if (steps.every((step) => step.ok)) {
      steps.push({ step: "gate-crash", ok: false, detail: error instanceof Error ? error.message : String(error) });
      await writeFile(reportPath, renderGateReport({ demoUrl: args.demoUrl, steps }));
    }
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }

  return { steps, reportPath };
}
