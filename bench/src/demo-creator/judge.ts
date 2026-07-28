import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { demoPaths } from "./demo-folder.js";
import { delay, firstLine } from "./exec.js";

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
  /** Keys the rubric never asked for, e.g. `overall`, `logo.confidence`. The
   * scores are still used; this is how they stop being silently dropped. */
  extras: string[];
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

/**
 * Every stage that asks a model for JSON gets the same tolerance: models
 * sometimes fence the object or top it with a sentence, and losing a whole
 * vision call to that is silly. `label` names the asking stage in the error,
 * which is the only thing that makes a live-run log readable.
 *
 * Lives here because this is where the model-reply lessons were learned; the
 * brief stage (same model, same seam) imports it.
 */
export function extractJsonObject(raw: string, label: string): Record<string, unknown> {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`${label} did not return JSON:\n${raw.slice(0, 400)}`);
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON (${error instanceof Error ? error.message : String(error)}):\n${raw.slice(0, 400)}`);
  }
}

/**
 * The keys an object literal declares AT the given brace depth, in order,
 * duplicates included — string- and escape-aware.
 *
 * `JSON.parse` cannot answer this: it collapses `{"logo":…,"logo":…}` to the LAST
 * value silently, so a model that emitted two different logo scores had the
 * recorded one decided by ordering. The only way to see the ambiguity is to read
 * the text.
 */
export function declaredKeys(objectText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  let capturing = false;
  for (let index = 0; index < objectText.length; index += 1) {
    const character = objectText[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        if (capturing) {
          // A string at depth 1 is a key only if a colon follows it.
          const rest = objectText.slice(index + 1).trimStart();
          if (rest.startsWith(":")) keys.push(current);
          capturing = false;
        }
      } else if (capturing) current += character;
      continue;
    }
    if (character === '"') {
      inString = true;
      if (depth === 1) {
        capturing = true;
        current = "";
      }
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  return keys;
}

/** Parses the judge model's JSON into a verdict; every pinned dimension must be
 * present exactly once with an integer 1-10 score. Anything the rubric did not
 * ask for is reported rather than dropped. */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const parsed = extractJsonObject(raw, "Judge");
  const declared = declaredKeys(rawObjectText(raw));
  const duplicates = [...new Set(declared.filter((key, index) => declared.indexOf(key) !== index))];
  if (duplicates.length > 0) {
    throw new Error(
      `Judge output rejected: duplicate key(s) ${duplicates.map((key) => `"${key}"`).join(", ")} — two answers for one dimension, and JSON parsing would silently keep whichever came last`,
    );
  }
  const scores: DimensionScore[] = [];
  const extras: string[] = [];
  for (const dimension of judgeDimensions) {
    const entry = parsed[dimension] as { score?: unknown; justification?: unknown } | undefined;
    const score = entry?.score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
      throw new Error(`Judge output rejected: "${dimension}" needs an integer score 1-10 (got ${JSON.stringify(score)})`);
    }
    const given = entry?.justification;
    // Whitespace-only is absent: a blank table cell reads as "the judge had
    // nothing to say", which is not what happened.
    const justification = typeof given === "string" && given.trim() !== "" ? given : "(no justification given)";
    scores.push({ dimension, score, justification });
    for (const field of Object.keys(entry as Record<string, unknown>)) {
      if (field !== "score" && field !== "justification") extras.push(`${dimension}.${field}`);
    }
  }
  for (const key of Object.keys(parsed)) {
    if (!(judgeDimensions as readonly string[]).includes(key)) extras.push(key);
  }
  return { scores, extras };
}

/** The JSON object's own text, as {@link extractJsonObject} finds it — the input
 * {@link declaredKeys} has to read (a re-serialised parse has already lost the
 * duplicates it exists to detect). */
function rawObjectText(raw: string): string {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start === -1 || end <= start ? "{}" : unfenced.slice(start, end + 1);
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

/**
 * The judge's retry budget, tightened.
 *
 * It was 30s/60s/120s across TWO model tiers, and `runJudge` rerolls the whole
 * call once on malformed JSON: 4 attempts × 2 models × 2 rolls = up to 16 vision
 * calls and ~14 minutes inside a 20-minute end-to-end target — for scores that
 * are a REPORT and never block the ship.
 *
 * ONE backoff per tier: the burst this exists for (opus-5 Overloaded for 6+
 * minutes straight, observed live) is answered by the SONNET TIER, not by waiting
 * longer on a model that is out. Worst case is now 8 vision calls and ~2 minutes,
 * both pinned by a test.
 */
export const judgeBackoffsMs = [30_000];

/** Vision call through the stock ai SDK + ANTHROPIC_API_KEY (lazy import —
 * only the judge pays for it). */
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
  const backoffsMs = judgeBackoffsMs;
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
        await delay(wait);
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

/**
 * One Markdown table cell of MODEL TEXT.
 *
 * A justification is whatever the judge wrote, and it goes straight into a table
 * row: a `|` splits the row into extra columns and a newline ends the row early,
 * so one chatty justification silently broke the whole score table.
 */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

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
  .map((score) => `| ${score.dimension} | ${score.score} | ${score.score >= fidelityThreshold ? "pass" : "FAIL"} | ${cell(score.justification)} |`)
  .join("\n")}`;
  // Keys the rubric never asked for are a note, not a silence: they mean the
  // model answered a slightly different question than the one we asked.
  const extras = options.verdict?.extras ?? [];
  const notes = extras.length === 0
    ? options.notes
    : [...options.notes, `the judge also returned key(s) the rubric never asked for, which were not scored: ${extras.join(", ")}`];
  return `# Fidelity report — ${options.prospect}

${options.verdict === undefined ? "Scores: none (see notes)." : `Scores: ${formatScoresLine(options.verdict)}`}
Bar: ${fidelityThreshold}/10 per dimension (a report, not a gate — this stage never blocks the ship).
Scored against ${options.evidence.length} evidence image(s)${options.evidence.length === 0 ? "" : `: ${options.evidence.map((image) => image.label).join("; ")}`}.
Built screens: ${options.builtScreens.length === 0 ? "(none captured)" : options.builtScreens.map((screen) => path.basename(screen)).join(", ")}

${notes.map((note) => `NOTE: ${note}`).join("\n")}${notes.length === 0 ? "" : "\n"}
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
  // SHIP REGARDLESS means the FILESYSTEM too: this read and the report write
  // below used to sit outside every catch, so a missing or unwritable RESEARCH/
  // threw out of the judge, the pipeline awaited it before ship, and a finished
  // demo never deployed over a directory permission.
  let evidence: JudgeImage[] = [];
  try {
    evidence = await readEvidenceImages(paths.researchDir);
  } catch (error) {
    notes.push(`could not read the evidence screenshots in ${path.join("demos", args.slug, "RESEARCH")}/: ${causeLine(error)}`);
  }
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
          write(`[judge] verdict parse failed (${causeLine(error)}) — rerolling once`);
          verdict = parseJudgeVerdict(await judgeModel(prompt, images));
        }
        write(`[judge] ${formatScoresLine(verdict)}`);
      } catch (error) {
        // SHIP REGARDLESS: a dead judge costs us the scores, not the demo.
        notes.push(`the judge did not score this demo: ${causeLine(error)}`);
        write(`[judge] scoring failed — shipping unscored (${causeLine(error)})`);
      }
    });
  }

  const reportPath = path.join(paths.researchDir, "FIDELITY.md");
  try {
    await writeFile(
      reportPath,
      renderFidelityReport({ prospect: args.prospect, ...(verdict === undefined ? {} : { verdict }), builtScreens, evidence, notes }),
    );
  } catch (error) {
    // The scores are already in the return value and on stdout; losing the file
    // costs the record, not the demo.
    const note = `could not write ${path.join("demos", args.slug, "RESEARCH", "FIDELITY.md")}: ${causeLine(error)}`;
    notes.push(note);
    write(`[judge] ${note}`);
  }
  return {
    ...(verdict === undefined ? {} : { verdict }),
    builtScreens,
    reportPath,
    scoresLine: verdict === undefined ? judgeFailedLine : formatScoresLine(verdict),
    notes,
  };
}

/** One-line cause for a note, a log line or a rethrow: unwrap the Error, then
 * take the first line through exec.ts's shared splitter. Exported for the brief
 * stage, which rethrows the same way. */
export function causeLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return firstLine(message) ?? message;
}
