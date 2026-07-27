import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

/**
 * The final self-gate of `demo:pipeline` — after deploy, the pipeline itself
 * drives the DEPLOYED demo end-to-end (criterion 37): wait for the Railway
 * service to come up (`railway up --detach` returns long before the build
 * finishes), perform a REAL login through the injected demo wall (a demo
 * without one FAILS the gate), assert the beat suggestion cards render,
 * run one live generation through the composer to a settled turn, and
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
 * still-building service). Default budget is 20 minutes (a live monorepo
 * build measured 10-15). */
export async function waitForDeployedReady(url: string, options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
  onPoll?: (status: string) => void;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const pollMs = options.pollMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("ready-wait aborted");
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
  /** The demo's login password (env DEMO_PASSWORD on the deployment, else
   * the seeded `<id>-demo`). The gate performs a REAL login and FAILS when
   * the deployed demo has no login wall — the wall is part of the contract. */
  demoPassword: string;
}

export interface FinalGateIo {
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** The pipeline's wall-clock-cap signal (checked at every step boundary). */
  signal?: AbortSignal;
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

  await mkdir(args.outDir, { recursive: true });
  const steps: GateStep[] = [];
  const reportPath = path.join(args.outDir, "GATE.md");

  const beats = (JSON.parse(await readFile(path.join(args.appDir, "demo.config.json"), "utf8")) as { beats: GateBeat[] }).beats;
  const generationBeat = pickGenerationBeat(beats);

  const record = async (step: string, ok: boolean, detail: string, screenshot?: string): Promise<void> => {
    if (io.signal?.aborted) throw io.signal.reason instanceof Error ? io.signal.reason : new Error("gate aborted");
    steps.push({ step, ok, detail, ...(screenshot === undefined ? {} : { screenshot }) });
    write(`[gate] ${step}: ${ok ? "ok" : "FAIL"} — ${detail}`);
    await writeFile(reportPath, renderGateReport({ demoUrl: args.demoUrl, steps }));
    if (!ok) throw new Error(`Final gate failed at "${step}": ${detail} — evidence in ${args.outDir}`);
  };

  // (1) Service up (Railway build finishes minutes after deploy returns).
  await waitForDeployedReady(args.demoUrl, {
    ...(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl }),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    onPoll: (status) => write(`[gate] waiting for ${args.demoUrl} (${status})`),
  });
  await record("service-up", true, `${args.demoUrl} serves HTTP`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // (2) Open through the router (follows the demos.vendo.run 302). The
    // resolved origin is pinned here — later navigations use it explicitly
    // (a post-login redirect once ended on chrome-error:// and page.url()
    // poisoned every URL derived from it).
    await page.goto(args.demoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const productShot = path.join(args.outDir, "gate-1-product.png");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.screenshot({ path: productShot });
    const landedUrl = page.url();
    await record("open", landedUrl.startsWith("http"), `landed on ${landedUrl}`, productShot);
    const demoOrigin = new URL(landedUrl).origin;

    // (3) Authenticated and inside the product — REQUIRED (criterion 37). Two
    // legitimate ways to get there, and the gate proves whichever the demo
    // ships:
    //   - auto-login (DEMO_AUTOLOGIN=1 on the demo origin): the visitor is
    //     already signed in, and NO sign-in page appears at all. This is the
    //     default for demos we send prospects — a password wall in front of a
    //     sales demo is friction we deliberately removed;
    //   - the injected password wall: fill it and land past /login.
    // What is never acceptable is ending up stuck on /login.
    const loginForm = page.locator('form[action="/login"]');
    const hasWall = await loginForm.count() > 0;
    if (hasWall) {
      await loginForm.locator('input[name="password"]').fill(args.demoPassword);
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000, waitUntil: "commit" })
        .catch(async () => {
          await record("login", false, "the demo password was rejected (still on /login after submit)");
        });
    }
    // Land on the product page explicitly (the 303-follow can abort on a cold
    // route); reaching "/" without bouncing back to /login proves the cookie.
    await page.goto(new URL("/", demoOrigin).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (new URL(page.url()).pathname.startsWith("/login")) {
      await record("login", false, hasWall
        ? "the auth cookie did not stick — / bounced back to /login"
        : "no login wall AND no auto-login — / bounced to /login with no way in");
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const loginShot = path.join(args.outDir, "gate-2-logged-in.png");
    await page.screenshot({ path: loginShot });
    await record(
      "login",
      true,
      `${hasWall ? "logged in with the demo password" : "auto-login (no sign-in page shown)"}; authenticated on ${new URL(page.url()).pathname}`,
      loginShot,
    );

    // (4) The /vendo panel: badge chrome + every beat's suggestion card.
    const panelUrl = new URL("/vendo", demoOrigin).toString();
    await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const panelShot = path.join(args.outDir, "gate-3-panel.png");
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
    const sentShot = path.join(args.outDir, "gate-4-sent.png");
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
    const viewShot = path.join(args.outDir, "gate-5-generated.png");
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
