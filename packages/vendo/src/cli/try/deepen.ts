import { join } from "node:path";
import { z } from "zod";
import type { ExtractionHarness } from "../extract/harness.js";
import { runSeedsPass } from "../extract/seeds.js";
import { applyBrief, runBriefStage, staticToolSchema, type StagedStageStatus, type StaticTool } from "../extract/stages.js";
import { selectJudgmentEngines } from "../judge/engine.js";
import { runJudgmentPass } from "../judge/pass.js";
import { readOptional, type Output } from "../shared.js";
import type { TryEventBus } from "./server.js";

/**
 * Background deepening behind `npx vendo try` (unified try surface, Task 6):
 * after the deterministic pass painted and the server is up, this orchestrator
 * runs the judgment pass (evidence-backed grades on the extracted catalog), the
 * brief stage, and then the seeds pass (use-case chips + synthetic fixtures)
 * over the SAME engine ladder init uses.
 *
 * The LATENCY LAW: deepening never blocks the server. It runs fire-and-forget
 * (`void runDeepening(...)`) beside an already-listening server, streams
 * progress through the shared TryEventBus, and NEVER throws — every failure
 * lands in the summary and the event stream, so a dropped promise can't take
 * anything down. The server picks artifacts up on its own (per-request
 * profile assembly + mount recomposition); nothing here talks to it directly.
 *
 * The ZERO-COMMIT LAW: deepening writes ONLY under `profileRoot`. The judgment
 * pass and the brief stage EXPLORE the host repo (`root: repoRoot`) but land
 * every artifact under the profile root — the judgment pass through its `out`
 * directory, the brief stage through `artifactRoot` — and `applyBrief` plus the
 * seeds pass are rooted at the profile root outright. The host repo stays
 * read-only, byte for byte.
 *
 * Loosenings QUEUE here rather than prompting: `vendo try` is non-interactive by
 * design, so a loosening that needs a human waits as `pending` in the profile's
 * judgments.json instead of being auto-applied. Consent lives with the caller —
 * the CLI (Task 7) decides whether AI runs at all and only then calls this.
 * No engine available (or a pinned `--engine` that isn't) is a SKIP, never an
 * error.
 */

/** Every stage the deepening stream reports, in emission order. The first two
 *  are the model passes over the catalog; seeds is this module's own. (No theme
 *  stage here: the deterministic pass already wrote theme.json.) */
const DEEPENING_STAGES = ["judgment", "brief", "seeds"] as const;

export interface RunDeepeningOptions {
  /** The host repo the extraction harness explores. NEVER written to. */
  repoRoot: string;
  /** The try profile root — the ONE directory deepening writes under. */
  profileRoot: string;
  /** The bus shared with the try server; all progress streams through it as
   *  `{ type: "stage", stage, status }` events. */
  events: TryEventBus;
  env: Record<string, string | undefined>;
  output?: Output;
  /** Pin the engine family (`--engine`). An unavailable pin skips deepening —
   *  never a fallback to another provider (the judgment ladder's pin posture). */
  engine?: string;
  /** Test seam: the engine ladder (judge/engine.ts's default when omitted). */
  harnesses?: ExtractionHarness[];
}

export interface DeepeningSummary {
  extraction: "ran" | "skipped" | "failed";
  seeds: "written" | "failed" | "skipped";
  /** The engine family that ran ("claude" | "codex" | "npx"), when one did. */
  engine?: string;
}

/** tools.json as the seeds pass consumes it. */
const staticToolsFileSchema = z.object({ tools: z.array(staticToolSchema) });

/** Missing or unparseable tools.json degrades to null — deepening skips. */
async function readStaticTools(profileRoot: string): Promise<StaticTool[] | null> {
  const raw = await readOptional(join(profileRoot, ".vendo", "tools.json")).catch(() => null);
  if (raw === null) return null;
  try {
    return staticToolsFileSchema.parse(JSON.parse(raw)).tools;
  } catch {
    return null;
  }
}

/** The host product's name, for the model prompts (read against the HOST repo —
 *  package.json is optional context). Exported so the try command (cli/try.ts)
 *  derives the surface's brand.name the SAME way instead of keeping a second
 *  copy of this read. */
export async function readAppName(repoRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse((await readOptional(join(repoRoot, "package.json"))) ?? "{}") as { name?: string };
    return parsed.name ?? "app";
  } catch {
    return "app";
  }
}

export async function runDeepening(options: RunDeepeningOptions): Promise<DeepeningSummary> {
  const { repoRoot, profileRoot, events, env, output } = options;
  const emit = (stage: string, status: StagedStageStatus, extra?: Record<string, unknown>): void => {
    events.emit({ type: "stage", stage, status, ...extra });
  };
  const skipAll = (reason: string): DeepeningSummary => {
    for (const stage of DEEPENING_STAGES) emit(stage, "skipped", { reason });
    return { extraction: "skipped", seeds: "skipped" };
  };

  try {
    // The deterministic pass's tools.json is what both the judgment pass and
    // the seeds pass judge — without it there is nothing to deepen.
    const tools = await readStaticTools(profileRoot);
    if (tools === null) {
      output?.log("deepening: no extracted tools in the profile — skipped.");
      return skipAll("no-tools");
    }

    // The SAME engine ladder init rides, availability-checked against the
    // host repo; an unavailable pin skips loudly, never a fallback.
    const available = await selectJudgmentEngines({
      root: repoRoot,
      env,
      ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
    });
    const chosen = options.engine === undefined
      ? available[0]
      : available.find((entry) => entry.family === options.engine);
    if (chosen === undefined) {
      output?.log(options.engine === undefined
        ? "deepening: no extraction engine available — the surface stays on the deterministic profile."
        : `deepening: \`--engine ${options.engine}\` isn't available on this machine — skipped, no fallback.`);
      return skipAll("no-engine");
    }

    const appName = await readAppName(repoRoot);
    const onProgress = (line: string): void => output?.log(`  ${line}`);
    // The pass narrates through the caller's output; a headless run discards it
    // rather than the pass having to care whether anyone is listening.
    const passOutput: Output = output ?? { log: () => {}, error: () => {} };
    let extraction: DeepeningSummary["extraction"] = "ran";

    emit("judgment", "started");
    try {
      const judged = await runJudgmentPass({
        root: repoRoot,
        out: join(profileRoot, ".vendo"),
        mode: "full",
        loosenings: "queue",
        env,
        output: passOutput,
        harness: chosen.harness,
        appName,
        onProgress,
      });
      // The pass is fail-soft: an unusable model reply comes back as "skipped"
      // (already narrated as a warning) rather than a throw. Report THAT, not a
      // blanket "done" — a stream that claims a stage finished when nothing was
      // judged is the kind of lie this surface exists to avoid.
      emit("judgment", judged.status === "judged" || judged.status === "up-to-date" ? "done" : "skipped");
    } catch (error) {
      extraction = "failed";
      emit("judgment", "failed");
      output?.error(`deepening judgment did not complete (${error instanceof Error ? error.message : "unknown error"}) — the deterministic profile stands.`);
    }

    // The brief reads whatever the judgment pass settled, so it runs after it —
    // and runs even when judgment failed, because a brief drafted from the
    // deterministic catalog still deepens the surface.
    emit("brief", "started");
    try {
      const brief = await runBriefStage({
        root: repoRoot,
        artifactRoot: profileRoot,
        env,
        harness: chosen.harness,
        appName,
        judged: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
        })),
        onProgress,
      });
      for (const note of brief.notes) output?.error(`  ${note}`);
      if (brief.fromStage) await applyBrief(profileRoot, brief.brief, false);
      emit("brief", brief.fromStage ? "done" : "failed");
    } catch (error) {
      emit("brief", "failed");
      output?.error(`deepening brief did not complete (${error instanceof Error ? error.message : "unknown error"}) — the current brief stands.`);
    }

    // Seeds, on the SAME harness, judging whatever actually landed: the brief
    // is re-read from disk so a failed/partial run feeds the honest null-brief
    // instructions instead of an in-memory draft that never landed.
    emit("seeds", "started");
    const briefRaw = await readOptional(join(profileRoot, ".vendo", "brief.md")).catch(() => null);
    const brief = briefRaw === null || briefRaw.trim() === "" ? null : briefRaw.trim();
    const seeded = await runSeedsPass({
      harness: chosen.harness,
      profileRoot,
      brief,
      tools,
      env,
      ...(output === undefined ? {} : { output }),
    });
    emit("seeds", seeded.status === "written" ? "done" : "failed");

    return { extraction, seeds: seeded.status, engine: chosen.family };
  } catch (error) {
    // The fire-and-forget guarantee: nothing escapes. This lane is for the
    // unexpected (a harness availability probe throwing, an unreadable
    // profile root) — mark every stage still open as failed and say so.
    const known = events.stages();
    for (const stage of DEEPENING_STAGES) {
      if (known[stage] === undefined) emit(stage, "failed");
    }
    output?.error(`deepening failed (${error instanceof Error ? error.message : "unknown error"}) — the surface keeps its current profile.`);
    return { extraction: "failed", seeds: "failed" };
  }
}
