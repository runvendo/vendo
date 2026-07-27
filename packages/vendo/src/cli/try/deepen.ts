import { join } from "node:path";
import { z } from "zod";
import { applyDraft, reportApplied, selectExtractionEngines } from "../extract/extraction.js";
import type { ExtractionHarness } from "../extract/harness.js";
import { runSeedsPass } from "../extract/seeds.js";
import { runStagedExtraction, staticToolSchema, type StagedStageStatus, type StaticTool } from "../extract/stages.js";
import { readOptional, type Output } from "../shared.js";
import type { TryEventBus } from "./server.js";

/**
 * Background deepening behind `npx vendo try` (unified try surface, Task 6):
 * after the deterministic pass painted and the server is up, this orchestrator
 * runs the staged AI extraction (survey → drafts → cross-check → brief) and
 * then the seeds pass (use-case chips + synthetic fixtures) over the SAME
 * engine ladder init uses.
 *
 * The LATENCY LAW: deepening never blocks the server. It runs fire-and-forget
 * (`void runDeepening(...)`) beside an already-listening server, streams
 * progress through the shared TryEventBus, and NEVER throws — every failure
 * lands in the summary and the event stream, so a dropped promise can't take
 * anything down. The server picks artifacts up on its own (per-request
 * profile assembly + mount recomposition); nothing here talks to it directly.
 *
 * The ZERO-COMMIT LAW: deepening writes ONLY under `profileRoot`. The staged
 * extraction explores the HOST repo (`root: repoRoot`) but lands every
 * artifact under the profile root (`artifactRoot: profileRoot` — the split
 * stages.ts carries for exactly this caller); applyDraft and the seeds pass
 * are rooted at the profile root outright. The host repo stays read-only,
 * byte for byte.
 *
 * Consent lives with the caller: `vendo try` is non-interactive by design, so
 * the CLI (Task 7) decides whether AI runs at all and only then calls this —
 * no TTY prompt exists on this path. No engine available (or a pinned
 * `--engine` that isn't) is a SKIP, never an error.
 */

/** Every stage the deepening stream reports, in emission order. The first
 *  four mirror runStagedExtraction's onStage stages (no theme stage here: the
 *  deterministic pass already wrote theme.json); seeds is this module's own. */
const DEEPENING_STAGES = ["survey", "drafts", "cross-check", "brief", "seeds"] as const;

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
   *  never a fallback to another provider (extraction.ts's pin posture). */
  engine?: string;
  /** Test seam: the engine ladder (extraction.ts's default when omitted). */
  harnesses?: ExtractionHarness[];
}

export interface DeepeningSummary {
  extraction: "ran" | "skipped" | "failed";
  seeds: "written" | "failed" | "skipped";
  /** The engine family that ran ("claude" | "codex" | "npx"), when one did. */
  engine?: string;
}

/** tools.json as the staged pipeline consumes it (runAiExtraction's read). */
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

/** The host product's name, for the extraction prompts (runAiExtraction's
 *  read, against the HOST repo — package.json is optional context). Exported
 *  so the try command (cli/try.ts) derives the surface's brand.name the SAME
 *  way instead of keeping a second copy of this read. */
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
    // The deterministic pass's tools.json is what both the staged extraction
    // and the seeds pass judge — without it there is nothing to deepen.
    const tools = await readStaticTools(profileRoot);
    if (tools === null) {
      output?.log("deepening: no extracted tools in the profile — skipped.");
      return skipAll("no-tools");
    }

    // The SAME engine ladder init rides, availability-checked against the
    // host repo; an unavailable pin skips loudly, never a fallback.
    const available = await selectExtractionEngines({
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

    // Staged extraction, PROGRESS-HOOK CHOICE: stages.ts's own onStage seam
    // (added for this caller — a few behavior-preserving lifecycle calls at
    // the points onProgress already narrates) relays each stage straight onto
    // the bus. Chosen over polling the artifacts dir, which could only see
    // terminal states, late, and never distinguish started from pending.
    const terminal = new Map<string, StagedStageStatus>();
    const onStage = (stage: string, status: StagedStageStatus): void => {
      terminal.set(stage, status);
      emit(stage, status);
    };
    let extraction: DeepeningSummary["extraction"] = "ran";
    try {
      const staged = await runStagedExtraction({
        root: repoRoot,
        artifactRoot: profileRoot,
        env,
        harness: chosen.harness,
        tools,
        appName: await readAppName(repoRoot),
        onStage,
        ...(output === undefined ? {} : { onProgress: (line) => output.log(`  ${line}`) }),
      });
      const applied = await applyDraft({ root: profileRoot, draft: staged.draft, tools });
      if (output !== undefined) {
        reportApplied({
          output,
          applied,
          briefDrafted: applied.briefWritten && staged.briefFromStage,
          artifactsNote: " (stage artifacts: .vendo/data/extract/)",
          notes: staged.notes,
        });
      }
    } catch (error) {
      extraction = "failed";
      // Truthful terminal events for whatever the throw cut short: a stage
      // caught mid-flight failed; one that never started was skipped.
      for (const stage of DEEPENING_STAGES.slice(0, -1)) {
        const status = terminal.get(stage);
        if (status === undefined) emit(stage, "skipped");
        else if (status === "started") emit(stage, "failed");
      }
      output?.error(`deepening extraction did not complete (${error instanceof Error ? error.message : "unknown error"}) — the deterministic profile stands.`);
    }

    // Seeds, on the SAME harness, judging whatever actually landed: the brief
    // is re-read from disk so a failed/partial extraction feeds the honest
    // null-brief instructions instead of an in-memory draft that never landed.
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
