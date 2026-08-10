/**
 * The harness lane: what the RESIDENT agent can actually do.
 *
 * The screen lane benchmarks generation — a document, a page, pixels. This one
 * benchmarks the loop that lives in the product: multi-tool asks, arithmetic
 * across two results, recovery from a tool that failed, honesty when nothing
 * answers, a question instead of a guess, and a reference resolved three turns
 * later.
 *
 * It drives the SHIPPED door. `createVendo` composes the whole product — the
 * default `vendo()` harness, the real guard, the real transcript, the real
 * system prompt (assembled per turn, which is most of what competence IS) — and
 * every turn goes through `vendo.harness.stream`, the same door a host's chat
 * route calls. Nothing here reimplements a loop, and nothing here mocks one: a
 * harness bench that mocks the harness proves nothing. The only thing this file
 * substitutes is the WORLD — the host tools answer with the case's canned rows,
 * which is exactly what the screen lane substitutes too.
 *
 * The trace is the product's own record. Every guarded call is mirrored onto the
 * wire by the runtime (`packages/harnesses/src/wire.ts` `writeMirror`) before it
 * runs and again when it answers, so reading that stream back gives every call,
 * its arguments and its outcome — including the ones the guard refused, which no
 * registry wrapper can see.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Principal, RunContext, ToolRegistry } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import type { UIMessage } from "ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessChecks,
  harnessPasses,
  parseHarnessCases,
  type HarnessCase,
  type HarnessCheck,
  type RecordedCall,
  type RecordedTurn,
} from "./harness-checks.js";
import { HarnessJudgeContract, judgeTranscript } from "./harness-judge.js";
import { writeHarnessPreview } from "./harness-report.js";
import { rubricLines, type JudgeResult } from "./judge.js";
import { meteredModel, MODEL_IDS, type Meter, type ModelAlias, type UsageTotals } from "./meter.js";
import { tally } from "./report.js";
import type { Stage } from "./run.js";
import { designRules, worldRegistry } from "./vendo.js";
import { derive, jsonSchemaFromExample, loadWorld, type World } from "./world.js";

const PRINCIPAL: Principal = { kind: "user", subject: "genbench_harness" };

/**
 * One turn's whole budget.
 *
 * A resident turn is a handful of tool calls and a paragraph, so three minutes is
 * already generous — but the product also equips the app builder, and a turn that
 * decides to go and BUILD something takes minutes. Bounding it per turn rather
 * than per case keeps a three-turn case from spending the whole budget on turn 1
 * and reporting the rest as silence.
 */
export const TURN_TIMEOUT_MS = 3 * 60_000;

/**
 * The case's half of a result's comparability stamp.
 *
 * Every field is named rather than the object stringified whole, for the same
 * reason `caseHash` in world.ts names its four: the digest should be the case, not
 * whatever else someone left in the file beside it. Everything a case can say
 * changes what was asked or how it is graded, so everything a case can say is in
 * here.
 */
export const harnessCaseHash = (testCase: HarnessCase): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        testCase.id,
        testCase.turns,
        testCase.tools ?? null,
        testCase.gate ?? null,
        testCase.expectCalls ?? null,
        testCase.forbidCalls ?? null,
        testCase.maxToolCalls ?? null,
        testCase.mustAsk ?? null,
        testCase.mustAdmitFailure ?? null,
        testCase.mustSay ?? null,
        testCase.pass ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

export interface HarnessCaseResult {
  readonly run: string;
  readonly contender: string;
  readonly model: string;
  readonly case: string;
  readonly lane: "harness";
  /** Turn 1, so every reader that prints a case's prompt still has one. */
  readonly prompt: string;
  readonly turns: readonly RecordedTurn[];
  readonly checks: readonly HarnessCheck[];
  readonly pass: boolean;
  /** `stages` is the screen lane's own timeline shape (`Stage` in run.ts): one
   *  mark per turn, on the case's clock, so a reader that already knows how to
   *  print where the time went does not need a second vocabulary for this lane. */
  readonly timing: {
    readonly firstReplyMs?: number;
    readonly settledMs: number;
    readonly stages?: readonly Stage[];
  };
  readonly cost: { readonly usage: UsageTotals; readonly usd: number };
  readonly world: string;
  readonly caseHash: string;
  readonly judged: JudgeResult;
  readonly judgeContract: typeof HarnessJudgeContract;
  readonly failure?: string;
}

/**
 * The world this case actually runs against.
 *
 * A tool the world already has keeps its schema and takes the case's rows; a name
 * the world does not have is a tool this CASE brings, derived through the same
 * `derive` the world file goes through, so a case-defined tool and an authored one
 * are indistinguishable to everything downstream — the registry, the model's
 * listing, the report's data panel.
 */
export function harnessWorld(world: World, testCase: HarnessCase): World {
  const specs = new Map(Object.entries(testCase.tools ?? {}));
  if (specs.size === 0) return world;
  const tools = world.tools.map((tool) => {
    const spec = specs.get(tool.name);
    specs.delete(tool.name);
    if (spec?.data === undefined) return tool;
    return {
      ...tool,
      data: spec.data,
      descriptor: { ...tool.descriptor, outputSchema: jsonSchemaFromExample(spec.data) },
    };
  });
  for (const [name, spec] of specs) {
    const does = spec.does;
    if (does === undefined) {
      throw new Error(`genbench: case "${testCase.id}" defines tool "${name}" with no \`does\``);
    }
    tools.push(derive(name, { ...spec, does }, spec.data));
  }
  return { ...world, tools };
}

/**
 * The world's tools, with the case's failures injected.
 *
 * `worldRegistry` is the one definition of what a bench tool answers with, so this
 * wraps it rather than restating it: the only thing added is the refusal a case
 * asked for. `"first"` is the recovery case — the tool works the moment the agent
 * tries again, so a run that improvised instead of retrying is visible.
 */
export function benchRegistry(world: World, testCase: HarnessCase): ToolRegistry {
  const base = worldRegistry(world);
  const seen = new Map<string, number>();
  return {
    descriptors: async (ctx) => await base.descriptors(ctx),
    async execute(call, ctx) {
      const spec = testCase.tools?.[call.tool];
      const count = (seen.get(call.tool) ?? 0) + 1;
      seen.set(call.tool, count);
      if (spec?.fail === "always" || (spec?.fail === "first" && count === 1)) {
        return {
          status: "error",
          error: spec.error ?? { code: "not-found", message: `${call.tool} is unavailable right now` },
        };
      }
      return await base.execute(call, ctx);
    },
  };
}

interface StreamRead {
  readonly text: string;
  readonly calls: readonly RecordedCall[];
  readonly failure?: string;
}

/** A mirrored call before its outcome arrives. A call whose result frame never
 *  came — an aborted turn, a stream cut short — stays in this state, which is a
 *  fact about the turn and not a call to be dropped. */
interface OpenCall {
  tool: string;
  args: unknown;
  status: RecordedCall["status"];
  output?: unknown;
  why?: string;
}

/**
 * The product's own event stream, read back.
 *
 * The wire is an ai-SDK UIMessage stream over SSE: `data: {…}` frames, one JSON
 * chunk each. Text deltas are the reply; `tool-input-available` opens a call and
 * one of the three `tool-output-*` chunks closes it; an `error` chunk (or the
 * persisted `data-vendo-turn-error` part beside it) is the turn failing.
 */
export async function readTurnStream(response: Response): Promise<StreamRead> {
  const raw = await response.text();
  const open = new Map<string, OpenCall>();
  let text = "";
  let failure: string | undefined;
  for (const frame of raw.split("\n\n")) {
    if (!frame.startsWith("data: ")) continue;
    const body = frame.slice("data: ".length);
    if (body === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(body) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = chunk["toolCallId"] as string | undefined;
    switch (chunk["type"]) {
      case "text-delta":
        text += String(chunk["delta"] ?? "");
        break;
      case "tool-input-available":
        if (id !== undefined) {
          open.set(id, {
            tool: String(chunk["toolName"] ?? ""),
            args: chunk["input"],
            status: "error",
            why: "the call never came back",
          });
        }
        break;
      case "tool-output-available": {
        const call = id === undefined ? undefined : open.get(id);
        if (call !== undefined) {
          call.status = "ok";
          call.output = chunk["output"];
          delete call.why;
        }
        break;
      }
      case "tool-output-denied": {
        const call = id === undefined ? undefined : open.get(id);
        if (call !== undefined) {
          call.status = "denied";
          // The wire's denial frame carries no reason (the shipped thread reads
          // it off the native part), so the record says what is known.
          call.why = "the guard refused this call";
        }
        break;
      }
      case "tool-output-error": {
        const call = id === undefined ? undefined : open.get(id);
        if (call !== undefined) {
          call.status = "error";
          call.why = String(chunk["errorText"] ?? "");
        }
        break;
      }
      case "error":
        failure = String(chunk["errorText"] ?? "the turn reported an error");
        break;
      case "data-vendo-turn-error":
        failure = String((chunk["data"] as { message?: unknown } | undefined)?.message ?? "the turn failed");
        break;
      default:
        break;
    }
  }
  return { text: text.trim(), calls: [...open.values()], ...(failure === undefined ? {} : { failure }) };
}

const usageDelta = (before: UsageTotals, after: UsageTotals): UsageTotals => ({
  inputTokens: after.inputTokens - before.inputTokens,
  outputTokens: after.outputTokens - before.outputTokens,
  cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
  cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
  calls: after.calls - before.calls,
});

export interface HarnessRunRequest {
  /** Already scoped to this case's tools (see {@link harnessWorld}). */
  readonly world: World;
  readonly testCase: HarnessCase;
  /** The metered seat — the lane's only source of tokens, dollars and time. */
  readonly meter: Meter;
  readonly turnTimeoutMs?: number;
}

/**
 * One case, driven turn by turn down ONE thread.
 *
 * The thread is the point: turn 2 and turn 3 read the transcript the product
 * persisted, through the same repository a real conversation uses, so what the
 * agent still remembers is what the product actually remembers.
 *
 * A turn that fails STOPS the conversation. Sending turn 3 into a thread whose
 * turn 2 died would grade a reply against context it never had, and the missing
 * turns are reported rather than papered over (`answered` in harness-checks.ts).
 */
export async function runHarnessCase(request: HarnessRunRequest): Promise<readonly RecordedTurn[]> {
  const { world, testCase, meter } = request;
  const timeoutMs = request.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  // Private to this case: `memory://` skips the shared single-writer lock, so
  // two cases can never meet, and the transcript starts empty.
  const store = createStore({ dataDir: `memory://genbench-harness-${testCase.id}` });
  await store.ensureSchema();
  // `autopilot` unless the case gates writes, which is the whole difference
  // between "the agent may act" and "the agent must get consent first".
  const guard = createGuard({ store, policy: testCase.gate === undefined ? "autopilot" : "cautious" });
  // The person at the keyboard, answering the card the moment it is raised. This
  // is the shipped decision door (`guard.approvals.decide`), which is what makes
  // a gated case a real approval round trip instead of a ninety-second wait for
  // a tap that never comes.
  const stopWatching =
    testCase.gate === undefined
      ? () => undefined
      : guard.onApprovalRequested((requested) => {
          void guard.approvals
            .decide(requested.id, { approve: testCase.gate === "approve" }, PRINCIPAL)
            .catch(() => undefined);
        });

  const vendo = createVendo({
    models: { default: meter.model },
    principal: async () => PRINCIPAL,
    store,
    guard,
    // The same brief the screen lane hands every contender: what this product is,
    // and the house rules for how it talks about money and dates.
    instructions: designRules(world),
    theme: world.theme,
  });
  vendo.actions.add(benchRegistry(world, testCase));

  const ctx: RunContext = {
    principal: PRINCIPAL,
    venue: "chat",
    // Present, so a parked approval is waited on rather than refused outright —
    // an unattended turn turns every call into an ask (guard.ts), which would
    // gate the reads too and measure nothing.
    presence: "present",
    sessionId: `genbench_${testCase.id}`,
  };
  const threadId = `thr_${testCase.id.replaceAll("-", "_")}`;
  const turns: RecordedTurn[] = [];

  try {
    for (const [index, ask] of testCase.turns.entries()) {
      const before = { usage: meter.totals(), usd: meter.usd() };
      const startedAt = performance.now();
      let read: StreamRead;
      try {
        const response = await vendo.harness.stream({
          threadId,
          message: { id: `m${index + 1}`, role: "user", parts: [{ type: "text", text: ask }] } as UIMessage,
          ctx,
          signal: AbortSignal.timeout(timeoutMs),
        });
        read = await readTurnStream(response);
      } catch (error) {
        read = { text: "", calls: [], failure: error instanceof Error ? error.message : String(error) };
      }
      const after = { usage: meter.totals(), usd: meter.usd() };
      turns.push({
        ask,
        reply: read.text,
        calls: read.calls,
        ms: Math.round(performance.now() - startedAt),
        cost: { usage: usageDelta(before.usage, after.usage), usd: after.usd - before.usd },
        ...(read.failure === undefined ? {} : { failure: read.failure }),
      });
      if (read.failure !== undefined) break;
    }
  } finally {
    stopWatching();
    await store.close();
  }
  return turns;
}

/**
 * The rubric for a case that produced no conversation: every line failed.
 *
 * That is the CONTENDER failing, not the judge, so it is not degraded and no
 * judge call is spent on a transcript that does not exist. Graded rather than
 * skipped, because a case that quietly drops out of the rubric is a benchmark
 * that flatters whoever crashed.
 */
const ungraded = (caseLines: readonly string[]): JudgeResult => ({
  lines: rubricLines(caseLines, []).map((entry) => ({
    ...entry,
    verdict: "fail" as const,
    note: "no conversation was delivered to grade",
  })),
  degraded: false,
});

/** One column of one case, start to finish, reporting rather than throwing. */
async function runOne(input: {
  world: World;
  scoped: World;
  testCase: HarnessCase;
  model: ModelAlias;
  meter: Meter;
  runId: string;
  runDir: string;
}): Promise<HarnessCaseResult> {
  const { scoped, testCase, meter } = input;
  let turns: readonly RecordedTurn[] = [];
  let failure: string | undefined;
  try {
    turns = await runHarnessCase({ world: scoped, testCase, meter });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const checks = harnessChecks({ testCase, turns, worldTools: scoped.tools.map((tool) => tool.name) });
  // Outside the case's own clock and never added into its cost, exactly as the
  // screen lane's judge is: the wait and the bill are the benchmark's.
  const judged =
    turns.length === 0
      ? ungraded(testCase.pass ?? [])
      : await judgeTranscript({ turns, caseLines: testCase.pass ?? [] });

  let atMs = 0;
  const stages: Stage[] = turns.map((turn, index) => {
    atMs += turn.ms;
    return { label: `turn ${index + 1}`, atMs };
  });
  const result: HarnessCaseResult = {
    run: input.runId,
    contender: `vendo-${input.model}`,
    model: MODEL_IDS[input.model],
    case: testCase.id,
    lane: "harness",
    prompt: testCase.turns[0] ?? "",
    turns,
    checks,
    pass: harnessPasses(checks),
    timing: {
      ...(turns[0] === undefined ? {} : { firstReplyMs: turns[0].ms }),
      settledMs: atMs,
      ...(stages.length === 0 ? {} : { stages }),
    },
    cost: { usage: meter.totals(), usd: meter.usd() },
    world: input.world.hash,
    caseHash: harnessCaseHash(testCase),
    judged,
    judgeContract: HarnessJudgeContract,
    ...(failure === undefined ? {} : { failure }),
  };

  const caseDir = join(input.runDir, result.contender, result.case);
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const failed = checks.filter((check) => !check.pass);
  console.log(
    `· ${result.contender} / ${testCase.id} · checks ${checks.length - failed.length}/${checks.length}` +
      ` · judged ${judged.degraded ? "—" : tally(judged.lines)}` +
      ` · ${result.timing.settledMs}ms · $${result.cost.usd.toFixed(4)}` +
      (failed.length === 0 ? "" : ` · FAILED: ${failed.map((check) => check.name).join(", ")}`) +
      (judged.degraded ? ` · JUDGE DEGRADED: ${judged.error ?? ""}` : ""),
  );
  return result;
}

/** What the lane needs off the command line. A structural subset of the screen
 *  lane's `Args`, declared here so the CLI hands its own value over and this
 *  module never imports the runner it is called from. */
export interface HarnessLaneArgs {
  readonly only?: string;
  readonly models: readonly ModelAlias[];
  readonly world: string;
  /** An external cases file, for a held-out set that does not live in the repo. */
  readonly cases?: string;
}

/**
 * The lane, as the CLI runs it: `genbench run --lane harness`.
 *
 * Cases run one after another — each one is a live conversation with its own
 * store, and running two at once would only buy speed by putting the machine's
 * contention inside the numbers. Models run together, like the screen lane's row.
 */
export async function harnessLane(args: HarnessLaneArgs): Promise<number> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    console.error("genbench: ANTHROPIC_API_KEY is not set");
    return 1;
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const worldDir = join(root, "worlds", args.world);
  const world = await loadWorld(worldDir);
  const casesPath = args.cases ?? join(worldDir, "harness-cases.json");
  const all = parseHarnessCases(await readFile(casesPath, "utf8"));
  const cases = all.filter((entry) => args.only === undefined || entry.id === args.only);
  if (cases.length === 0) throw new Error(`genbench: no harness case matches --prompt "${args.only ?? ""}"`);

  const anthropic = createAnthropic({ apiKey });
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(root, "runs", runId);
  const results: HarnessCaseResult[] = [];
  const worlds: Record<string, World> = {};

  for (const testCase of cases) {
    const scoped = harnessWorld(world, testCase);
    worlds[testCase.id] = scoped;
    const row = await Promise.all(
      args.models.map(async (model) => {
        const modelId = MODEL_IDS[model];
        // Its own meter, so one model's tokens and one model's clock are never
        // charged to the other.
        const meter = meteredModel(anthropic(modelId), modelId);
        return await runOne({ world, scoped, testCase, model, meter, runId, runDir });
      }),
    );
    results.push(...row);
  }

  const preview = await writeHarnessPreview({ runDir, runId, results, worlds });
  console.log(preview);
  // The deterministic checks decide the exit code and nothing else does — the
  // judge is a third party on someone else's infrastructure, and the same
  // posture the screen lane's floor takes applies here.
  const failed = results.filter((result) => !result.pass).length;
  console.log(`check failures: ${failed} (exit ${failed === 0 ? 0 : 1})`);
  return failed === 0 ? 0 : 1;
}
