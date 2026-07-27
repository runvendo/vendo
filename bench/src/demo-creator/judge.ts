import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { bootDemoHost, configDemoHost } from "../demo-capture/hosts.js";
import type { ExecFn } from "./deploy.js";
import { defaultExec } from "./deploy.js";
import type { ResearchReport } from "./research.js";
import { defaultRunAgent, fencedFiles, type RewritePlan, type RunAgentFn } from "./rewrite.js";

/**
 * The visual judge loop — the stage that keeps `demo:pipeline` from silently
 * shipping a mediocre clone. After the rewrite builds, the demo's screens are
 * screenshotted (booting the app the same way demo-capture does) and a vision
 * model scores them against BOTH the operator-provided screenshots and the
 * live-site research capture, on five pinned dimensions (logo, palette, type,
 * layout, copyTone), 1-10 each. Every dimension must reach 7. Below the bar,
 * each failing dimension gets ONE targeted fix agent per round (capped), then
 * rebuild → recapture → re-judge. Rounds exhausted below the bar ⇒ the run
 * PARKS with a ship-or-park report — it never deploys.
 */

export const judgeDimensions = ["logo", "palette", "type", "layout", "copyTone"] as const;
export type JudgeDimension = (typeof judgeDimensions)[number];

/** Every dimension must score at least this to ship. */
export const fidelityThreshold = 7;

export interface DimensionScore {
  dimension: JudgeDimension;
  /** 1-10. */
  score: number;
  justification: string;
}

export interface JudgeVerdict {
  scores: DimensionScore[];
  failing: JudgeDimension[];
  pass: boolean;
}

const dimensionRubric: Record<JudgeDimension, string> = {
  logo: "Is the prospect's REAL logo rendered in the header/nav exactly where their product puts it? A missing, wrong, or generic logo is 1-3; the real mark in the right place is 8-10.",
  palette: "Do the built screens use the prospect's EXACT colors (background, text, accent) with zero hue drift against the evidence? 'Close but off' hues or surviving template neutrals cap this at 5-6.",
  type: "Does the typography match — the same (or metrically matching) font family, weight pairing, and size hierarchy as the evidence?",
  layout: "Is the main built screen a STRUCTURAL 1:1 of the reference product screen — same regions, same nav items and labels, same column set, same header composition? 'Inspired by' layouts with different regions score 4-6.",
  copyTone: "Do labels, headings, and seeded record names use the prospect's domain vocabulary and register (as seen in the evidence), with plausible invented data — no placeholder-ish or wrong-domain copy?",
};

export function buildJudgePrompt(options: { prospect: string }): string {
  return `You are a harsh brand-fidelity judge. The images that follow are labeled either EVIDENCE (the real ${options.prospect} product: operator-provided screenshots and a live-site capture) or BUILT (screens of a demo app that is supposed to mimic ${options.prospect} exactly).

Score the BUILT screens against the EVIDENCE on five dimensions, 1-10 each. Be harsh: start every dimension at 5 and move only on visible evidence. A prospect employee glancing at the BUILT screens should believe they are looking at their own product.

${judgeDimensions.map((dimension) => `- ${dimension}: ${dimensionRubric[dimension]}`).join("\n")}

Output ONLY a JSON object (no prose, no markdown fence), exactly:
{
${judgeDimensions.map((dimension) => `  "${dimension}": { "score": <1-10 integer>, "justification": "<one line citing the specific visual evidence compared>" }`).join(",\n")}
}`;
}

/** Parses the judge model's JSON into a verdict; every pinned dimension must
 * be present with an integer 1-10 score and a non-empty justification. */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`Judge did not return JSON:\n${raw.slice(0, 400)}`);
  let parsed: Record<string, { score?: unknown; justification?: unknown }>;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as typeof parsed;
  } catch (error) {
    throw new Error(`Judge returned invalid JSON (${error instanceof Error ? error.message : String(error)}):\n${raw.slice(0, 400)}`);
  }
  const scores: DimensionScore[] = [];
  for (const dimension of judgeDimensions) {
    const entry = parsed[dimension];
    const score = entry?.score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
      throw new Error(`Judge output rejected: "${dimension}" needs an integer score 1-10 (got ${JSON.stringify(score)})`);
    }
    const justification = typeof entry?.justification === "string" && entry.justification !== "" ? entry.justification : "(no justification given)";
    scores.push({ dimension, score, justification });
  }
  const failing = scores.filter((entry) => entry.score < fidelityThreshold).map((entry) => entry.dimension);
  return { scores, failing, pass: failing.length === 0 };
}

// ---------------------------------------------------------------------------
// Judge model call (vision)
// ---------------------------------------------------------------------------

export interface JudgeImage {
  /** Shown to the model right before the image, e.g. 'BUILT screen "/" (Board)'. */
  label: string;
  path: string;
}

/** Model seam: prompt + labeled images in, raw model text out. */
export type JudgeModelFn = (prompt: string, images: JudgeImage[]) => Promise<string>;

/** Vision call through the stock ai SDK + ANTHROPIC_API_KEY (lazy import —
 * only the judge pays for it). API overload passes in minutes, and one judge
 * call gates a ~$9 rewrite — so on top of the SDK's own quick retries, wait
 * out transient errors with 30s/60s/120s backoff before giving up (an
 * "Overloaded" burst killed a live run at judge:round-1). */
export const defaultJudgeModel: JudgeModelFn = async (prompt, images) => {
  const [{ createAnthropic }, { generateText }] = await Promise.all([import("@ai-sdk/anthropic"), import("ai")]);
  const anthropic = createAnthropic({});
  const modelId = process.env.VENDO_DEMO_JUDGE_MODEL ?? "claude-opus-5";
  const content: ({ type: "text"; text: string } | { type: "image"; image: Buffer })[] = [
    { type: "text", text: prompt },
  ];
  for (const image of images) {
    content.push({ type: "text", text: `\n${image.label}:` });
    content.push({ type: "image", image: await readFile(image.path) });
  }
  const backoffsMs = [30_000, 60_000, 120_000];
  // Tier fallback after the backoff exhausts: a sustained opus overload must
  // not kill a run that a sonnet judge can score (observed live: opus-5
  // Overloaded for 6+ minutes straight).
  const fallbackModelId = "claude-sonnet-5";
  const models = modelId === fallbackModelId ? [modelId] : [modelId, fallbackModelId];
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
      try {
        const result = await generateText({
          model: anthropic(model),
          messages: [{ role: "user", content }],
        });
        return result.text;
      } catch (error) {
        lastError = error;
        const wait = backoffsMs[attempt];
        if (wait === undefined) break; // next model tier
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
};

// ---------------------------------------------------------------------------
// Built-screen capture (reuses the demo-capture boot)
// ---------------------------------------------------------------------------

export interface CaptureScreensOptions {
  appDir: string;
  repoRoot: string;
  /** Routes to screenshot, e.g. ["/", "/backlog"]. */
  routes: string[];
  port: number;
  /** Absolute output directory for the round's screenshots. */
  outDir: string;
  logFile: string;
}

/** Boots the built demo (same machinery as demo-capture), signs in through
 * the injected login wall, and screenshots each route at the research
 * viewport (1440x900). Returns absolute paths. */
export async function captureBuiltScreens(options: CaptureScreensOptions): Promise<string[]> {
  const { host } = await configDemoHost(options.appDir);
  const running = await bootDemoHost({
    host,
    port: options.port,
    repoRoot: options.repoRoot,
    logFile: options.logFile,
    timeoutMs: 180_000,
  });
  await mkdir(options.outDir, { recursive: true });
  const saved: string[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // The clone ships a login wall (injected at demo:create); authenticate
    // once, then the cookie carries the rest of the routes.
    await page.goto(new URL("/", running.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const loginForm = page.locator('form[action="/login"]');
    if (await loginForm.count() > 0) {
      const password = (host.demoPasswordEnv === undefined ? undefined : process.env[host.demoPasswordEnv])
        ?? host.demoPasswordFallback ?? "";
      await loginForm.locator('input[name="password"]').fill(password);
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000, waitUntil: "commit" });
    }
    for (const route of options.routes) {
      await page.goto(new URL(route, running.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const stem = route === "/" ? "home" : route.replaceAll("/", "-").replace(/^-+|-+$/g, "");
      const filePath = path.join(options.outDir, `built-${stem}.png`);
      await page.screenshot({ path: filePath });
      saved.push(filePath);
    }
  } finally {
    await browser.close().catch(() => undefined);
    await running.stop();
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Evidence selection + fix prompts + report
// ---------------------------------------------------------------------------

/** The judge compares against BOTH operator screenshots and the live-site
 * capture — criterion 36 requires both classes, so a missing class is a
 * hard verdict (`missing`), not a silent drop: the loop PARKS on it rather
 * than shipping a demo scored against half the evidence. */
export function selectEvidenceImages(report: ResearchReport, researchDir: string): {
  images: JudgeImage[];
  /** Evidence classes required by criterion 36 that are absent on disk. */
  missing: ("operator-screenshots" | "live-site-capture")[];
} {
  const operator: JudgeImage[] = report.operatorScreenshots
    .map((shot) => ({
      label: `EVIDENCE operator screenshot (${shot.file} — real logged-in product UI)`,
      path: path.join(researchDir, shot.file),
    }))
    .filter((image) => existsSync(image.path));
  const live: JudgeImage[] = [];
  for (const page of report.pages) {
    if ("error" in page || page.botChallenge) continue;
    const candidate = {
      label: `EVIDENCE live-site capture (${page.url})`,
      path: path.join(researchDir, page.screenshots.viewport),
    };
    if (existsSync(candidate.path)) {
      live.push(candidate);
      break; // one live capture is enough alongside the operator shots
    }
  }
  const missing: ("operator-screenshots" | "live-site-capture")[] = [];
  if (operator.length === 0) missing.push("operator-screenshots");
  if (live.length === 0) missing.push("live-site-capture");
  return { images: [...operator, ...live], missing };
}

export function buildFixPrompt(options: {
  prospect: string;
  dimension: JudgeDimension;
  score: DimensionScore;
  round: number;
}): string {
  const targets: Record<JudgeDimension, string> = {
    logo: "src/app/layout.tsx and the shell components (src/components/shell/) — the logo file itself lives in public/brand/",
    palette: "src/app/globals.css and any component carrying hard-coded colors; .vendo/theme.json may be corrected ONLY with exact values from RESEARCH/research.json colorRoles",
    type: "the font loading in src/app/layout.tsx and the type scale in src/app/globals.css",
    layout: "src/app/page.tsx and src/components/home/ — region-by-region against the reference screen",
    copyTone: "src/server/seed.ts, visible labels in the pages/components, and demo.config.json beat copy",
  };
  return `You are a targeted FIX agent for a ${options.prospect} demo (round ${options.round}). The visual judge failed ONE dimension; fix exactly that, with the smallest change set.

FAILED DIMENSION: ${options.dimension} — scored ${options.score.score}/10 (needs ${fidelityThreshold}).
Judge's justification: ${options.score.justification}

Read RESEARCH/BRAND.md and LOOK at the evidence images it lists (operator screenshots first), then at RESEARCH/judge/ for the built-screen captures the judge saw. Likely files: ${targets[options.dimension]}.

Rules: NEVER touch the fenced files (${fencedFiles.join(", ")}). All data stays invented. Do not "fix" other dimensions — one dimension, minimal diff.`;
}

export interface JudgeRound {
  round: number;
  verdict: JudgeVerdict;
  builtScreens: string[];
}

/** RESEARCH/FIDELITY.md — the per-dimension score table for every round,
 * written whether the run ships or parks (criterion 35: a parked run names
 * each failed dimension). */
export function renderFidelityReport(options: {
  prospect: string;
  rounds: JudgeRound[];
  parked: boolean;
  evidence: JudgeImage[];
}): string {
  const roundBlocks = options.rounds.map((round) => {
    const rows = round.verdict.scores
      .map((score) => `| ${score.dimension} | ${score.score} | ${score.score >= fidelityThreshold ? "pass" : "FAIL"} | ${score.justification} |`)
      .join("\n");
    return `## Round ${round.round} — ${round.verdict.pass ? "PASS" : `FAIL (${round.verdict.failing.join(", ")})`}

| Dimension | Score | ≥${fidelityThreshold}? | Justification |
| --- | --- | --- | --- |
${rows}

Built screens: ${round.builtScreens.map((screen) => path.basename(screen)).join(", ")}`;
  }).join("\n\n");
  const final = options.rounds[options.rounds.length - 1];
  return `# Fidelity report — ${options.prospect}

Verdict: ${options.parked ? `**PARKED — DO NOT SHIP.** Failing dimensions after all rounds: ${final?.verdict.failing.join(", ") ?? "(none scored)"}` : "**SHIP** — every dimension at or above the bar."}
Threshold: every dimension ≥ ${fidelityThreshold}/10. Scored against ${options.evidence.length} evidence image(s): ${options.evidence.map((image) => image.label).join("; ")}.

${roundBlocks}
`;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface JudgeLoopArgs {
  prospect: string;
  packageName: string;
  plan: RewritePlan;
  port: number;
}

export interface JudgeLoopIo {
  appDir: string;
  repoRoot: string;
  judgeModel?: JudgeModelFn;
  captureScreens?: (options: CaptureScreensOptions) => Promise<string[]>;
  runAgent?: RunAgentFn;
  exec?: ExecFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** The pipeline's wall-clock-cap signal (checked each round; kills fix agents). */
  signal?: AbortSignal;
}

export interface JudgeLoopResult {
  rounds: JudgeRound[];
  parked: boolean;
  reportPath: string;
  costUsd: number;
}

/** Initial judge + up to this many fix-and-rejudge rounds. Keeps the loop
 * inside the 45-minute budget next to a ~10-minute Railway floor. */
export const maxFixRounds = 2;

export async function runJudgeLoop(args: JudgeLoopArgs, io: JudgeLoopIo): Promise<JudgeLoopResult> {
  const judgeModel = io.judgeModel ?? defaultJudgeModel;
  const captureScreens = io.captureScreens ?? captureBuiltScreens;
  const runAgent = io.runAgent ?? defaultRunAgent;
  const exec = io.exec ?? defaultExec;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const model = env.VENDO_DEMO_AGENT_MODEL ?? "sonnet";

  const researchDir = path.join(io.appDir, "RESEARCH");
  const report = JSON.parse(await readFile(path.join(researchDir, "research.json"), "utf8")) as ResearchReport;
  const { images: evidence, missing } = selectEvidenceImages(report, researchDir);
  if (missing.length > 0) {
    // Criterion 36: every score is computed against BOTH operator screenshots
    // and the live-site capture. A run without either class parks — it never
    // ships on half the evidence.
    const reportPath = path.join(researchDir, "FIDELITY.md");
    await writeFile(reportPath, `# Fidelity report — ${args.prospect}

Verdict: **PARKED — DO NOT SHIP.** The judge requires BOTH evidence classes and the run is missing: ${missing.join(", ")}.
No dimension was scored; provide the missing evidence (operator screenshots via --screenshots; a clean live capture via demo:research) and re-run.
`);
    write(`[judge] PARKED: missing required evidence class(es): ${missing.join(", ")}`);
    return { rounds: [], parked: true, reportPath, costUsd: 0 };
  }
  const routes = args.plan.screens.map((screen) => screen.route);
  const prompt = buildJudgePrompt({ prospect: args.prospect });

  const rounds: JudgeRound[] = [];
  let costUsd = 0;
  let parked = false;

  for (let round = 1; ; round += 1) {
    if (io.signal?.aborted) throw io.signal.reason instanceof Error ? io.signal.reason : new Error("judge aborted");
    const roundResult = await runStage(`judge:round-${round}`, async () => {
      const outDir = path.join(researchDir, "judge", `round-${round}`);
      const builtScreens = await captureScreens({
        appDir: io.appDir,
        repoRoot: io.repoRoot,
        routes,
        port: args.port,
        outDir,
        logFile: path.join(outDir, "server.log"),
      });
      const builtImages: JudgeImage[] = builtScreens.map((screen, index) => ({
        label: `BUILT screen ${routes[index] ?? path.basename(screen)}`,
        path: screen,
      }));
      // One reroll on malformed output: models occasionally glitch the JSON
      // (a live run died on a doubled colon), and a fresh sample is cheaper
      // than losing the whole run to it.
      let verdict: JudgeVerdict;
      try {
        verdict = parseJudgeVerdict(await judgeModel(prompt, [...evidence, ...builtImages]));
      } catch (error) {
        write(`[judge] verdict parse failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — rerolling once`);
        verdict = parseJudgeVerdict(await judgeModel(prompt, [...evidence, ...builtImages]));
      }
      write(`[judge] round ${round}: ${verdict.scores.map((score) => `${score.dimension}=${score.score}`).join(" ")} → ${verdict.pass ? "PASS" : `FAIL (${verdict.failing.join(", ")})`}`);
      return { round, verdict, builtScreens };
    });
    rounds.push(roundResult);

    if (roundResult.verdict.pass) break;
    if (round > maxFixRounds) {
      parked = true;
      write(`[judge] rounds exhausted below threshold — PARKING (no deploy). Failing: ${roundResult.verdict.failing.join(", ")}`);
      break;
    }

    await runStage(`judge:fix-${round}`, async () => {
      // One targeted fix agent per failing dimension, run SERIALLY: fixes for
      // different dimensions legitimately touch the same files (globals.css),
      // so parallel here would race.
      for (const dimension of roundResult.verdict.failing) {
        const score = roundResult.verdict.scores.find((entry) => entry.dimension === dimension) as DimensionScore;
        write(`[judge] fix round ${round}: ${dimension} (${score.score}/10)`);
        const fix = await runAgent({
          name: `fix-${dimension}-${round}`,
          prompt: buildFixPrompt({ prospect: args.prospect, dimension, score, round }),
          maxBudgetUsd: 5,
          timeoutMs: 12 * 60 * 1000,
          model,
        }, { cwd: io.appDir, env, ...(io.signal === undefined ? {} : { signal: io.signal }) });
        costUsd += fix.costUsd ?? 0;
        if (fix.code !== 0) throw new Error(`Fix agent for ${dimension} failed (exit ${fix.code}):\n${fix.output.slice(0, 1000)}`);
      }
      const build = await exec(["pnpm", "exec", "turbo", "run", "build", `--filter=${args.packageName}`], { cwd: io.repoRoot });
      if (build.code !== 0) {
        throw new Error(`Build broken after fidelity fixes:\n${(build.stderr || build.stdout).slice(-3000)}`);
      }
    });
  }

  const reportPath = path.join(researchDir, "FIDELITY.md");
  await writeFile(reportPath, renderFidelityReport({ prospect: args.prospect, rounds, parked, evidence }));
  return { rounds, parked, reportPath, costUsd };
}
