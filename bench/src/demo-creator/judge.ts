import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { demoPaths } from "./demo-folder.js";

/**
 * Stage 5 — the visual judge, ONE pass.
 *
 * The demo is already built and running inside the vendo-demos host (stage 4
 * booted it and hands us its base URL). We screenshot the demo's own routes,
 * hand them to a vision model alongside the operator's evidence screenshots,
 * and record five pinned scores (logo, palette, type, layout, copyTone).
 *
 * The scores are a REPORT, not a gate: the contract is SHIP REGARDLESS. There
 * is no fix loop and nothing parks here — a missing evidence class or a dead
 * judge model is a NOTE in RESEARCH/FIDELITY.md and an honest SCORES line, and
 * the pipeline ships anyway. Human judgement decides what to do with a 4.
 */

export const judgeDimensions = ["logo", "palette", "type", "layout", "copyTone"] as const;
export type JudgeDimension = (typeof judgeDimensions)[number];

/** The bar a dimension has to clear to read as "right". */
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
  return `You are a harsh brand-fidelity judge. The images that follow are labeled either EVIDENCE (the real ${options.prospect} product: operator-provided screenshots) or BUILT (screens of a demo app that is supposed to mimic ${options.prospect} exactly).

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

/**
 * The one line the pipeline prints as `SCORES: ` + this, e.g.
 * `logo=PASS palette=8 type=7 layout=9 copyTone=8`.
 *
 * `logo` is the one dimension reported as PASS/FAIL rather than a number: the
 * model still scores it 1-10 through the shared rubric, and PASS means it
 * reached {@link fidelityThreshold}. A logo is binary to a human — it is
 * either their mark or it isn't — so a number there invites false precision.
 */
export function formatScoresLine(verdict: JudgeVerdict): string {
  return verdict.scores
    .map((score) => score.dimension === "logo"
      ? `logo=${score.score >= fidelityThreshold ? "PASS" : "FAIL"}`
      : `${score.dimension}=${score.score}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Judge model call (vision)
// ---------------------------------------------------------------------------

export interface JudgeImage {
  /** Shown to the model right before the image, e.g. 'BUILT screen /acme'. */
  label: string;
  path: string;
}

/** Model seam: prompt + labeled images in, raw model text out. */
export type JudgeModelFn = (prompt: string, images: JudgeImage[]) => Promise<string>;

/** Vision call through the stock ai SDK + ANTHROPIC_API_KEY (lazy import —
 * only the judge pays for it). API overload passes in minutes, so on top of
 * the SDK's own quick retries, wait out transient errors with 30s/60s/120s
 * backoff before giving up (an "Overloaded" burst killed a live run at
 * judge:round-1). */
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
// Evidence + built-screen capture
// ---------------------------------------------------------------------------

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * The evidence half of the comparison: the operator screenshots stage 1 copied
 * into `demos/<slug>/RESEARCH/`. Read straight off disk by extension rather
 * than from a manifest, so any naming the evidence stage picks is honored.
 * Subdirectories are skipped on purpose — `RESEARCH/context-dev/` holds raw API
 * responses and `RESEARCH/judge/` holds our own built screenshots.
 */
export async function readEvidenceImages(researchDir: string): Promise<JudgeImage[]> {
  const entries = await readdir(researchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      label: `EVIDENCE operator screenshot (${name} — real logged-in product UI)`,
      path: path.join(researchDir, name),
    }));
}

export interface CaptureScreensOptions {
  /** Base URL of the ALREADY-RUNNING host (stage 4 booted it). */
  baseUrl: string;
  /** Routes to screenshot, e.g. ["/acme", "/acme/vendo"]. */
  routes: string[];
  /** Absolute output directory for the screenshots. */
  outDir: string;
}

/**
 * Screenshots each route at the research viewport (1440x900) and returns
 * absolute paths. Boots nothing (stage 4 owns the host process) and signs in
 * to nothing — the host auto-logs in via its own middleware.
 */
export async function captureBuiltScreens(options: CaptureScreensOptions): Promise<string[]> {
  await mkdir(options.outDir, { recursive: true });
  const saved: string[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    for (const route of options.routes) {
      await page.goto(new URL(route, options.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      // networkidle is best-effort (a demo with a live connection never idles);
      // the fixed settle is what actually catches late-mounting client chrome.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const stem = route.replaceAll("/", "-").replace(/^-+|-+$/g, "") || "home";
      const filePath = path.join(options.outDir, `built-${stem}.png`);
      await page.screenshot({ path: filePath });
      saved.push(filePath);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return saved;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** RESEARCH/FIDELITY.md — the score table plus every note that kept a score
 * from being computed. Written on every run, scored or not. */
export function renderFidelityReport(options: {
  prospect: string;
  verdict?: JudgeVerdict;
  builtScreens: string[];
  evidence: JudgeImage[];
  notes: string[];
}): string {
  const table = options.verdict === undefined
    ? "No scores: the judge did not complete. See the notes above."
    : `| Dimension | Score | ≥${fidelityThreshold}? | Justification |
| --- | --- | --- | --- |
${options.verdict.scores
  .map((score) => `| ${score.dimension} | ${score.score} | ${score.score >= fidelityThreshold ? "pass" : "FAIL"} | ${score.justification} |`)
  .join("\n")}`;
  return `# Fidelity report — ${options.prospect}

${options.verdict === undefined ? "Scores: none (see notes)." : `Scores: ${formatScoresLine(options.verdict)}`}
Bar: ${fidelityThreshold}/10 per dimension (a report, not a gate — this stage never blocks the ship).
Scored against ${options.evidence.length} evidence image(s)${options.evidence.length === 0 ? "" : `: ${options.evidence.map((image) => image.label).join("; ")}`}.
Built screens: ${options.builtScreens.length === 0 ? "(none captured)" : options.builtScreens.map((screen) => path.basename(screen)).join(", ")}

${options.notes.map((note) => `NOTE: ${note}`).join("\n")}${options.notes.length === 0 ? "" : "\n"}
${table}
`;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface JudgeArgs {
  slug: string;
  prospect: string;
  /** Base URL of the host stage 4 left running. */
  baseUrl: string;
}

export interface JudgeIo {
  demosRepo: string;
  judgeModel?: JudgeModelFn;
  captureScreens?: (options: CaptureScreensOptions) => Promise<string[]>;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** The pipeline's wall-clock-cap signal. */
  signal?: AbortSignal;
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface JudgeResult {
  /** Absent when the judge could not score at all — the run still ships. */
  verdict?: JudgeVerdict;
  builtScreens: string[];
  reportPath: string;
  /** What the pipeline prints after `SCORES: `. */
  scoresLine: string;
  notes: string[];
}

/** The SCORES line for a run the judge never scored — an honest "we don't
 * know", so a reader never mistakes silence for a pass. */
const judgeFailedLine = "judge=FAILED";

export async function runJudge(args: JudgeArgs, io: JudgeIo): Promise<JudgeResult> {
  const judgeModel = io.judgeModel ?? defaultJudgeModel;
  const captureScreens = io.captureScreens ?? captureBuiltScreens;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());

  const paths = demoPaths(io.demosRepo, args.slug);
  const notes: string[] = [];
  const evidence = await readEvidenceImages(paths.researchDir);
  // The old loop PARKED on a missing evidence class. Scores are now a report,
  // so a missing class is a note — but with nothing to compare against there
  // is nothing honest to score, so the model call is skipped rather than paid
  // for a verdict about a demo the judge cannot see the target of.
  if (evidence.length === 0) {
    notes.push(`no operator screenshots in ${path.join("demos", args.slug, "RESEARCH")}/ — nothing to score the build against`);
  }

  // The product page and the full Vendo page — the two routes a prospect opens.
  const routes = [`/${args.slug}`, `/${args.slug}/vendo`];
  let verdict: JudgeVerdict | undefined;
  let builtScreens: string[] = [];
  if (evidence.length > 0) {
    await runStage("judge", async () => {
      if (io.signal?.aborted) {
        notes.push("skipped: the run's wall-clock cap fired before the judge");
        return;
      }
      try {
        builtScreens = await captureScreens({
          baseUrl: args.baseUrl,
          routes,
          outDir: path.join(paths.researchDir, "judge"),
        });
        const builtImages: JudgeImage[] = builtScreens.map((screen, index) => ({
          label: `BUILT screen ${routes[index] ?? path.basename(screen)}`,
          path: screen,
        }));
        const prompt = buildJudgePrompt({ prospect: args.prospect });
        const images = [...evidence, ...builtImages];
        // One reroll on malformed output: models occasionally glitch the JSON
        // (a live run died on a doubled colon), and a fresh sample is cheaper
        // than losing the scores to it.
        try {
          verdict = parseJudgeVerdict(await judgeModel(prompt, images));
        } catch (error) {
          write(`[judge] verdict parse failed (${firstLineOf(error)}) — rerolling once`);
          verdict = parseJudgeVerdict(await judgeModel(prompt, images));
        }
        write(`[judge] ${formatScoresLine(verdict)}`);
      } catch (error) {
        // SHIP REGARDLESS: a dead judge costs us the scores, not the demo.
        notes.push(`the judge did not score this demo: ${firstLineOf(error)}`);
        write(`[judge] scoring failed — shipping unscored (${firstLineOf(error)})`);
      }
    });
  }

  const reportPath = path.join(paths.researchDir, "FIDELITY.md");
  await writeFile(
    reportPath,
    renderFidelityReport({ prospect: args.prospect, ...(verdict === undefined ? {} : { verdict }), builtScreens, evidence, notes }),
  );
  return {
    ...(verdict === undefined ? {} : { verdict }),
    builtScreens,
    reportPath,
    scoresLine: verdict === undefined ? judgeFailedLine : formatScoresLine(verdict),
    notes,
  };
}

function firstLineOf(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}
