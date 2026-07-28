import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { defaultRunAgent, type AgentRunResult, type RunAgentFn } from "./agent.js";
import { runAssemble, type AssembleIo, type AssembleResult } from "./assemble.js";
import { syncTools } from "./build.js";
import { demoPaths, parseDemoFolderConfig, parseDemoSlug } from "./demo-folder.js";
import { defaultDemosRepo, ensureDemosRepo } from "./demos-repo.js";
import { createScrubber, defaultExec, type ExecFn } from "./exec.js";
import { runJudge, type JudgeIo, type JudgeResult } from "./judge.js";
import { assertOnlyDemoTouched, createStageRunner, createTimingsFile, localHostPort, quarantineFailedDemo, snapshotHostBaseline, type StageTiming } from "./pipeline.js";
import { runShip, type ShipIo, type ShipResult } from "./ship.js";

/**
 * `demo:fix` — the operator's second pass. A demo is already live and the
 * feedback is prose ("the sidebar should be dark", "call them Runs not Jobs"),
 * so this is deliberately ONE agent over the existing demo folder rather than a
 * regeneration: the evidence, brief and theme are already right, and rebuilding
 * from scratch would throw away the fidelity the first run earned.
 *
 * Everything after the agent is the pipeline's own tail — re-sync the tools,
 * assemble (a broken fix is never pushed), judge for the record, ship.
 */

export interface DemoFixArgs {
  id: string;
  instruction: string;
  demosRepo: string;
  skipShip: boolean;
}

const valueOptions = new Set(["--id", "--instruction", "--demos-repo"]);
const flagOptions = new Set(["--skip-ship"]);

export function parseDemoFixArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DemoFixArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (option?.startsWith("--") !== true) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  const id = options.get("--id");
  if (id === undefined) throw new Error("--id is required (the demo slug to fix)");
  parseDemoSlug(id, "--id (demo:fix)");
  const instruction = options.get("--instruction");
  if (instruction === undefined || instruction.trim() === "") {
    throw new Error('--instruction is required (free text, e.g. --instruction "the sidebar should be dark")');
  }
  return {
    id,
    instruction,
    demosRepo: options.get("--demos-repo") ?? defaultDemosRepo(env),
    skipShip: flags.has("--skip-ship"),
  };
}

/** What the fix agent may rewrite. The brand evidence (theme.json, BRIEF.md,
 * brand/, RESEARCH/) is settled truth from the first run and stays fenced:
 * a prose fix must never quietly redecide the prospect's colours. */
export const fixOwnedRoots = ["screens", "server", "openapi.json", "demo.config.json"] as const;

export function buildFixPrompt(options: { prospect: string; slug: string; instruction: string; brief: string }): string {
  return `You are fixing the live ${options.prospect} demo (slug "${options.slug}") in place. The operator has looked at it and asked for exactly this:

OPERATOR INSTRUCTION — AUTHORITATIVE:
${options.instruction}

Make the SMALLEST change set that satisfies it. Do not "improve" anything else: every unrelated edit is a regression risk on a demo that already passed its fidelity judge.

You are working inside the demo folder. YOUR FILE LIST (writable): ${fixOwnedRoots.join(", ")}.
FENCED — never edit: theme.json, BRIEF.md, brand/**, RESEARCH/**, tools.json (regenerated from openapi.json), and anything outside this folder (the host owns caps, watermark, auth and the Vendo kit).

Rules that still hold:
- ALL data is INVENTED. Evidence informs STYLE, never DATA. No real people, customers or records; no Foo/Bar/Lorem placeholders.
- screens/index.tsx default-exports the product page, takes NO props, reads seed data through server/ imports, and renders the Vendo surfaces imported from host/src/vendo-kit where demo.config.json's placement says.
- server/routes.ts exports \`routes\`: a Record of "METHOD /path" to a handler taking \`(request: Request)\` — NOT a store argument — and returning a Response; captured \`:name\` segments arrive as SEARCH PARAMS (\`new URL(request.url).searchParams.get("id")\`), and the data comes from \`getStore()\` in ./store. Every route it serves must stay declared in openapi.json — the agent's tool surface is generated from that file, so an undeclared route is a capability the demo cannot use.
- demo.config.json keeps all five beats (generate-ui, take-action, automation, connect-account, save-app), generate-ui keeps expectsView: true and take-action keeps expectsApproval: true.

The brand brief this demo was built from, for context:
${options.brief}`;
}

export interface DemoFixIo {
  runAgent?: RunAgentFn;
  exec?: ExecFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  capMs?: number;
  stages?: {
    ensureRepo: typeof ensureDemosRepo;
    syncTools: typeof syncTools;
    assemble: (args: Parameters<typeof runAssemble>[0], io: AssembleIo) => Promise<AssembleResult>;
    judge: (args: Parameters<typeof runJudge>[0], io: JudgeIo) => Promise<JudgeResult>;
    ship: (args: Parameters<typeof runShip>[0], io: ShipIo) => Promise<ShipResult>;
  };
}

export interface DemoFixResult {
  slug: string;
  /** The demo folder the fix landed in — what the operator is told to open. */
  demoDir: string;
  agent: AgentRunResult;
  timings: StageTiming[];
  judge: JudgeResult;
  scoresLine: string;
  ship?: ShipResult;
  liveUrl?: string;
}

export const fixCapMs = 25 * 60 * 1000;

/** The fix agent's spend cap. Sized like the build agents': one prose fix is a
 * SMALLER job than a whole demo, and the only thing that stops a looping agent
 * is this number. */
export const fixBudgetUsd = 4;

export async function runDemoFix(args: DemoFixArgs, io: DemoFixIo = {}): Promise<DemoFixResult> {
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const scrub = createScrubber(env);
  const runAgent = io.runAgent ?? defaultRunAgent;
  const stages = io.stages ?? { ensureRepo: ensureDemosRepo, syncTools, assemble: runAssemble, judge: runJudge, ship: runShip };
  const paths = demoPaths(args.demosRepo, args.id);

  const capController = new AbortController();
  const signal = capController.signal;
  const baseExec = io.exec ?? defaultExec;
  const exec: ExecFn = (command, options) => baseExec(command, { signal, ...options });
  const timings: StageTiming[] = [];
  const capMs = io.capMs ?? fixCapMs;
  const deadline = Date.now() + capMs;
  const capTimer = setTimeout(() => capController.abort(new Error(`the ${Math.round(capMs / 60000)}-minute cap fired`)), Math.max(0, capMs));
  capTimer.unref?.();
  const timingsFile = createTimingsFile({ timings, file: paths.timings, write });
  const runStage = createStageRunner({
    timings,
    writeTimings: timingsFile.flush,
    write,
    deadline,
    signal,
    capFired: (context) => new Error(`the ${Math.round(capMs / 60000)}-minute cap fired ${context}`),
  });

  // A failed stop leaks `next start` on the port and the NEXT run dies with a
  // boot error that looks like nothing to do with this one.
  const stopHost = async (running: AssembleResult["host"]): Promise<void> => {
    try {
      await running.stop();
    } catch (error) {
      write(`[fix] WARNING: the local host on port ${localHostPort} did not stop (${error instanceof Error ? error.message : String(error)}) — kill it before the next run: lsof -ti:${localHostPort} | xargs kill -9`);
    }
  };

  let host: AssembleResult["host"] | undefined;
  try {
    await runStage("repo", () => stages.ensureRepo(args.demosRepo, { exec, write, signal }));
    if (!existsSync(paths.config)) {
      throw new Error(`No demo at "${paths.root}" — demo:fix edits an existing demo; run demo:pipeline to create "${args.id}" first`);
    }
    const config = await parseDemoFolderConfig(JSON.parse(await readFile(paths.config, "utf8")), `demo config at "${paths.config}"`);
    const brief = existsSync(paths.brief) ? await readFile(paths.brief, "utf8") : "(BRIEF.md is missing — rely on the folder's existing code)";

    // The checkout before the fix agent runs — a demo:fix lands in a checkout
    // that has already shipped at least one demo, so its host artifacts are
    // always present and are never this agent's doing.
    const hostBaseline = await snapshotHostBaseline(args.demosRepo, args.id, { exec });

    const agent = await runStage("fix", async () => {
      const result = await runAgent(
        {
          name: `fix-${args.id}`,
          prompt: buildFixPrompt({ prospect: config.prospect, slug: args.id, instruction: args.instruction, brief }),
          maxBudgetUsd: fixBudgetUsd,
          timeoutMs: 15 * 60 * 1000,
          model: env.VENDO_DEMO_AGENT_MODEL ?? "sonnet",
        },
        {
          cwd: paths.root,
          env,
          signal,
          // The same FILE LIST the prompt states, enforced by the harness.
          sandbox: { writeRoot: paths.root, readRoot: args.demosRepo, ownedRoots: [...fixOwnedRoots] },
        },
      );
      write(`[fix] agent exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""} ($${result.costUsd?.toFixed(2) ?? "?"})`);
      if (result.permissionDenials.length > 0) {
        write(`[fix] the harness DENIED ${result.permissionDenials.length} write(s) outside the demo folder: ${result.permissionDenials.join(", ")}`);
      }
      // Scrubbed like build.ts's identical relay: a fix agent that hit a
      // credential error quotes it back in its final message, and this message
      // goes into an operator-visible throw and a Slack thread.
      if (result.code !== 0) throw new Error(`Fix agent failed (exit ${result.code}):\n${scrub(result.output.slice(0, 1000))}`);
      return result;
    });

    // What this fix actually cost, next to the cap that bounded it.
    write(`SPEND: $${(agent.costUsd ?? 0).toFixed(2)} on 1 fix agent run (cap $${fixBudgetUsd.toFixed(2)})`);

    // openapi.json may have moved, so the tool surface is regenerated and the
    // config re-validated before anything is built.
    await runStage("sync", async () => {
      const tools = await stages.syncTools({ demosRepo: args.demosRepo, slug: args.id, exec, signal });
      write(`[fix] ${tools} tools after re-sync`);
      await parseDemoFolderConfig(JSON.parse(await readFile(paths.config, "utf8")), `demo config at "${paths.config}"`);
    });

    // Last point where a change outside the demo folder can ONLY have come from
    // the fix agent: assemble legitimately writes the host's manifest next.
    await assertOnlyDemoTouched(args.demosRepo, args.id, { exec }, hostBaseline);

    const smokePrompt = config.beats[0]?.prompt ?? `Show me an overview of the ${config.prospect} data in this workspace.`;
    const assembled = await runStage("assemble", () => stages.assemble(
      { slug: args.id, port: localHostPort, smokePrompt },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage },
    ));
    host = assembled.host;

    const judge = await runStage("judge", () => stages.judge(
      { slug: args.id, prospect: config.prospect, baseUrl: assembled.host.baseUrl },
      { demosRepo: args.demosRepo, write, signal, runStage },
    ));
    const scoresLine = judge.scoresLine;
    write(`SCORES: ${scoresLine}`);

    await stopHost(host);
    host = undefined;

    if (args.skipShip) {
      write("[fix] --skip-ship: stopping after judge (nothing committed, pushed or deployed)");
      return { slug: args.id, demoDir: paths.root, agent, timings, judge, scoresLine };
    }
    const shipped = await runStage("ship", () => stages.ship(
      { slug: args.id, prospect: config.prospect },
      { demosRepo: args.demosRepo, write, env, exec, signal, runStage, finalizeTimings: timingsFile.finalize },
    ));
    return { slug: args.id, demoDir: paths.root, agent, timings, judge, scoresLine, ship: shipped, liveUrl: shipped.liveUrl };
  } catch (error) {
    // Same reason as the pipeline's: gen-manifest validates EVERY demo folder, so
    // a failed fix's leftovers break the next run in this checkout. Here the demo
    // is already committed, and git is what makes "clean" mean RESTORE rather
    // than delete — a live demo's source is never this cleanup's to remove.
    await quarantineFailedDemo({ demosRepo: args.demosRepo, slug: args.id, exec, write });
    throw error;
  } finally {
    clearTimeout(capTimer);
    if (host !== undefined) await stopHost(host);
  }
}
