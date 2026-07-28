import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DemoBeat } from "demo-template/demo-config";
import {
  assertDisjointOwnership,
  defaultRunAgent,
  type AgentJob,
  type AgentRunResult,
  type RunAgentFn,
} from "./agent.js";
import type { BrandBrief } from "./brief.js";
import {
  buildChipsPrompt,
  defaultChipModel,
  mergeBeats,
  parseChipsReply,
  readExtractedTools,
  type ChipModelFn,
} from "./chips.js";
import {
  beatVarietyProblems,
  demoPaths,
  parseDemoFolderConfig,
  requiredBeatKeys,
  type DemoTheme,
} from "./demo-folder.js";
import { defaultExec, firstLine, type ExecFn } from "./exec.js";

/**
 * Stage 3 of `demo:pipeline` — the demo folder's contents.
 *
 * Three headless `claude` agents run at ONCE over `demos/<slug>/`, each owning
 * a disjoint slice: the server + its OpenAPI spec, the cloned screens, and the
 * beats. They are parallel precisely because none of them needs another's
 * output — which is also why the beats agent cannot ground its own chips: the
 * tool surface does not exist until `vendo sync` reads the spec the server
 * agent is still writing. So grounding is a fourth, deterministic step after
 * the fan-out, and chips.ts (already the honest chip derivation) does it.
 */

/** Sonnet everywhere. A live run timed an opus screens pass out at 15 minutes
 * inside a 45-minute budget, and the fidelity judge is the quality backstop by
 * design — a slow perfect clone that never ships is worse than a fast good one. */
const agentModel = "sonnet";

/** Caps are frozen by the master contract, not an agent's choice. */
const frozenCaps = { maxTurns: 20, maxSpendUsd: 5 } as const;

/**
 * The `vendo` CLI that ships in THIS checkout. Resolved from the module rather
 * than from a repo root argument because the demo folder lives in a foreign
 * checkout (vendo-demos) that has no vendo dependency at all — and `pnpm exec
 * vendo` is worse than useless here: on this machine it resolves to an
 * unrelated `vendo` deployment CLI on PATH and exits 0 having done nothing.
 */
const vendoCli = fileURLToPath(new URL("../../../packages/vendo/bin/vendo.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

function sharedRules(prospect: string, brief: BrandBrief): string {
  return `THE BAR: EXACT mimicry of ${prospect} — someone who uses their product must recognise this as theirs at a glance. Generic-ish output fails the fidelity judge and wastes a fix round.

Non-negotiable rules:
- Read BRIEF.md FIRST, then LOOK at the reference screenshot it names (${brief.referenceScreenshot}). The screenshot outranks anything you infer.
- ONLY create or edit files in YOUR FILE LIST below. Two other agents are writing this same demo folder RIGHT NOW; everything outside your list belongs to one of them.
- NEVER write anything under host/. The caps guard, watermark, auth wall and the Vendo kit are host code shared by every demo — a demo that edits them breaks the other demos.
- NEVER edit theme.json, BRIEF.md, brand/ or RESEARCH/. They are already written from real brand evidence and are fenced.
- ALL data is INVENTED. No real people, emails, or records from any source material: evidence informs STYLE, never DATA. And no Foo/Bar/Lorem/Alpha/Bravo placeholders — every name, amount and date must read like a real ${prospect} record.
- Speak ${prospect}'s vocabulary (${brief.vocabulary.join(", ")}). Voice: ${brief.voice}
- theme.json already holds the exact brand tokens; the host applies them. Use the theme's CSS custom properties, never hardcoded hexes.`;
}

function entityBlock(brief: BrandBrief): string {
  return brief.entities
    .map((entity) => [
      `- ${entity.name} — file/route stem "${entity.stem}", ONE mutating action "${entity.action}"`,
      `  fields: ${entity.fields.join(", ")}`,
      `  sample records (seed these names VERBATIM — the beats name them): ${entity.sampleRecordNames.join(", ")}`,
    ].join("\n"))
    .join("\n");
}

/** Exactly three jobs, disjoint by construction — asserted anyway. */
export function buildAgentJobs(options: {
  slug: string;
  prospect: string;
  brief: BrandBrief;
  ctaUrl: string;
  expiresAt: string;
}): AgentJob[] {
  const { prospect, brief } = options;
  const rules = sharedRules(prospect, brief);
  const entities = entityBlock(brief);

  const jobs: AgentJob[] = [
    {
      name: "server",
      ownedRoots: ["server", "openapi.json"],
      maxBudgetUsd: 6,
      timeoutMs: 20 * 60 * 1000,
      model: agentModel,
      prompt: `You are the SERVER agent for a ${prospect} demo. You write the demo's domain: its data, its routes, and the OpenAPI spec those routes are extracted from.

${rules}

THE DOMAIN (from BRIEF.md — implement it exactly):
${entities}

YOUR TASK:
- server/entities.ts: the domain types above, plus the ONE mutating action per entity ("${brief.entities.map((entity) => entity.action).join('", "')}"). One mutation each, nothing speculative.
- server/seed.ts: the deterministic seed. Import the seeded prng as \`import { mulberry32 } from "@host/prng"\` — never Math.random, the demo must look identical on every boot. Export \`interface SeedData\`, \`buildSeed(anchor?: Date): SeedData\`, and \`getStore(): SeedData\` (a module singleton seeded at first import — screens/ reads the demo's data through getStore()). 10-20 records per entity: right magnitudes, coherent dates (created before updated, nothing in the future), a realistic status spread.
- The sample records above must seed in a state the mutating action can STILL act on — not already archived, closed, voided or paid. A beat names one of them, and an already-actioned record makes the agent correctly decline: no consent card appears and the beat dies in front of the prospect. Pin their state explicitly instead of leaving it to the prng.
- server/routes.ts: \`export const routes\` — a \`Record<"METHOD /path", (req: Request, store: SeedData) => Response>\` covering a list route per entity, a fetch-one route, and the mutation. Pick ONE response envelope and use it everywhere; whatever you pick, declare it in openapi.json. A response shape the spec does not describe is a shape the agent mis-reads, and the pill dead-ends.
- openapi.json: declare EVERY route in routes.ts — matching operationId, a one-sentence summary in the product's own words, path/query parameters with descriptions, and x-vendo-formats for money fields stored in cents.

openapi.json is the ONLY source of the demo agent's tools: a route missing from the spec does not exist to the agent. It needs at least one list route AND at least one mutating route, or the demo has nothing to show.

YOUR FILE LIST (writable): server/entities.ts, server/seed.ts, server/routes.ts, openapi.json.`,
    },
    {
      name: "screens",
      ownedRoots: ["screens"],
      maxBudgetUsd: 8,
      timeoutMs: 20 * 60 * 1000,
      model: agentModel,
      prompt: `You are the SCREENS agent for a ${prospect} demo. You write the product page — a 1:1 clone of the reference screenshot, and the fidelity-critical surface the judge scores.

${rules}

THE DOMAIN (another agent is writing server/ from the same brief, concurrently):
${entities}

YOUR TASK:
- screens/index.tsx default-exports the product page. It receives NO props. It reads the demo's data by importing the sibling seed directly — \`import { getStore } from "../server/seed"\` — and NEVER by fetching: a screen that fetched and guessed the route's envelope shipped once as a perfect-looking report page that listed nothing at all.
- The page is a STRUCTURAL 1:1 clone of ${brief.referenceScreenshot}: same regions, same nav labels (${brief.nav.join(" · ")}), same column set, same header composition, same density — populated from the seeded ${brief.entities.map((entity) => entity.name).join(" / ")} records. ${brief.productSurface}
- You may add sibling components under screens/ and import them.
- Render the Vendo surfaces where BRIEF.md's placement says: trigger in the ${brief.placement.trigger}, ${brief.placement.slot}. Import them ONLY from the pre-wired, per-demo-themed host kit \`@host/vendo-kit\` (host/src/vendo-kit): VendoRoot, VendoTrigger, VendoOverlay, VendoLayer, VendoPalette, VendoPage, VendoTabPage, VendoSlot, VendoThread. Never import from @vendoai/* directly and never re-implement a surface — the kit carries this demo's theme, and a hand-rolled panel is unthemed and off-brand.

YOUR FILE LIST (writable): screens/** only.`,
    },
    {
      name: "beats",
      ownedRoots: ["demo.config.json"],
      maxBudgetUsd: 2,
      timeoutMs: 8 * 60 * 1000,
      model: agentModel,
      prompt: `You are the BEATS agent for a ${prospect} demo. You write demo.config.json — the pills a prospect clicks, in ${prospect}'s own words.

${rules}

CHIP MATERIAL from BRIEF.md: ${brief.chipMaterial.join(" · ")}

THE DOMAIN (another agent is writing server/ from the same brief, concurrently):
${entities}

YOUR TASK — demo.config.json, exactly these five beats, in this order, with these keys:
1. "generate-ui" (must set \`expectsView: true\`): an IMPERATIVE prompt that renders a view over the seeded data — "Build me a ... showing ... and ...". Never a question: a question gets a prose answer, no view, and the beat fails verification.
2. "take-action" (must set \`expectsApproval: true\`): the consented mutation, naming ONE of the sample records above verbatim so the agent acts immediately instead of asking a clarifying question. Never invent a record name — only the ones listed above are seeded.
3. "automation": a recurring version of the work ("every Monday, ...").
4. "connect-account": pulls in an outside account (Gmail, Google Calendar or Slack — the only connectors this host offers).
5. "save-app": saves the generated view as a reusable app.

Each beat is { key, prompt, chip } plus the expectation flags above and nothing else — the schema is strict and a stray field fails the build. \`chip\` is a 2-5 word sentence-case label in ${prospect}'s vocabulary; \`prompt\` is the full sentence typed into the composer.

Also write \`placement\`: { "trigger": "${brief.placement.trigger}", "slot": ${JSON.stringify(brief.placement.slot)} }.

The pipeline stamps id, prospect, ctaUrl, expiresAt and caps over whatever you write — those are operator facts, not yours to invent. Write them as placeholders and move on.

tools.json does not exist yet: it is generated from the OpenAPI spec the server agent is writing right now, so you cannot check your pills against the real tool surface. The pipeline grounds them against it the moment you finish, and a pill it cannot ground is dropped. So stay inside the chip material and the entity actions above — those are the capabilities the server agent is being told to build.

YOUR FILE LIST (writable): demo.config.json only.`,
    },
  ];
  assertDisjointOwnership(jobs);
  return jobs;
}

// ---------------------------------------------------------------------------
// vendo sync
// ---------------------------------------------------------------------------

/** `vendo sync` over the demo folder, leaving the tools at
 * `demos/<slug>/tools.json`. Returns the product-tool count. */
export async function syncTools(options: {
  demosRepo: string;
  slug: string;
  exec: ExecFn;
  signal?: AbortSignal;
}): Promise<number> {
  const paths = demoPaths(options.demosRepo, options.slug);
  const result = await options.exec(
    ["node", vendoCli, "sync", paths.root, "--no-watermark"],
    { cwd: paths.root, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  if (result.code !== 0) {
    throw new Error(`vendo sync failed (exit ${result.code}) over demos/${options.slug}: ${firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output"}`);
  }

  // `vendoSync` defaults its `out` to `<root>/.vendo` and also drops a
  // catalog.json there. The frozen folder contract puts tools.json at the demo
  // root, and a stray .vendo/ would be committed into the host repo — so move
  // the one file we keep and delete the rest.
  const vendoDir = path.join(paths.root, ".vendo");
  const count = (await readExtractedTools(path.join(vendoDir, "tools.json"))).length;
  if (count === 0) {
    throw new Error(`vendo sync extracted no product tools from demos/${options.slug}/openapi.json — a demo whose agent can do nothing is not shippable`);
  }
  await rename(path.join(vendoDir, "tools.json"), paths.tools);
  await rm(vendoDir, { recursive: true, force: true });
  return count;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface BuildArgs {
  slug: string;
  prospect: string;
  ctaUrl: string;
  expiresAt: string;
  brief: BrandBrief;
  theme: DemoTheme;
}

export interface BuildIo {
  demosRepo: string;
  runAgent?: RunAgentFn;
  exec?: ExecFn;
  /** chips.ts's model seam, for the grounding pass. */
  chipModel?: ChipModelFn;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface BuildResult {
  agents: AgentRunResult[];
  toolCount: number;
  beats: DemoBeat[];
  costUsd: number;
}

/**
 * The beats agent's config, read WITHOUT the strict parse: its beats may be
 * missing kinds or carrying an ungrounded pill, and that is exactly what the
 * grounding pass and the repair round are for. The strict parse is the LAST
 * thing this stage does, on the merged result.
 */
async function readAgentConfig(configPath: string): Promise<{ config: Record<string, unknown>; beats: DemoBeat[] }> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not read the beats agent's ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const beats = (Array.isArray(config["beats"]) ? config["beats"] : []).filter((beat): beat is DemoBeat => {
    const candidate = beat as Partial<DemoBeat> | null;
    return typeof candidate?.key === "string" && typeof candidate.chip === "string" && typeof candidate.prompt === "string";
  });
  return { config, beats };
}

export async function runBuild(args: BuildArgs, io: BuildIo): Promise<BuildResult> {
  const runAgent = io.runAgent ?? defaultRunAgent;
  const exec = io.exec ?? defaultExec;
  const chipModel = io.chipModel ?? defaultChipModel;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const paths = demoPaths(io.demosRepo, args.slug);
  const agentOptions = { cwd: paths.root, env, ...(io.signal === undefined ? {} : { signal: io.signal }) };
  const agents: AgentRunResult[] = [];

  await runStage("build:agents", async () => {
    const jobs = buildAgentJobs({
      slug: args.slug,
      prospect: args.prospect,
      brief: args.brief,
      ctaUrl: args.ctaUrl,
      expiresAt: args.expiresAt,
    });
    write(`[build] ${jobs.map((job) => job.name).join(", ")} in parallel over demos/${args.slug} (brand font ${args.theme.typography.fontFamily})`);
    const results = await Promise.all(jobs.map((job) => runAgent(job, agentOptions)));
    agents.push(...results);
    for (const result of results) {
      write(`[build] agent ${result.name}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""} ($${result.costUsd?.toFixed(2) ?? "?"})`);
    }
    const failed = results.filter((result) => result.code !== 0);
    if (failed.length > 0) {
      throw new Error(`${failed.length} build agent(s) failed: ${failed.map((result) => `${result.name} (exit ${result.code}${result.timedOut ? ", timed out" : ""})`).join(", ")}\nFirst failure output:\n${failed[0]?.output.slice(0, 1000)}`);
    }
  });

  const toolCount = await runStage("build:sync", async () => {
    const count = await syncTools({
      demosRepo: io.demosRepo,
      slug: args.slug,
      exec,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    write(`[build] vendo sync: ${count} product tool(s) at demos/${args.slug}/tools.json`);
    return count;
  });

  const beats = await runStage("build:grounding", async () => {
    // Now the pills can finally be checked against something real.
    const tools = await readExtractedTools(paths.tools);
    const derived = parseChipsReply(
      await chipModel(buildChipsPrompt({ prospect: args.prospect, tools })),
      tools,
      (message) => write(`[build] ${message}`),
    );
    const authored = await readAgentConfig(paths.config);
    let config = authored.config;
    let merged = mergeBeats(authored.beats, derived);
    write(`[build] grounding: ${derived.length} pill(s) survived ${tools.length} tools, ${merged.length} beat(s) after merge`);

    let problems = beatVarietyProblems(merged);
    if (problems.length > 0) {
      // The repair agent edits the file, so it has to SEE the merged state —
      // including the derived pills — rather than the config it wrote itself.
      await writeFile(paths.config, `${JSON.stringify({ ...config, beats: merged }, null, 2)}\n`);
      write(`[build] beat variety: ${problems.join("; ")} — one repair agent`);
      const repairJob: AgentJob = {
        name: "beats-repair",
        ownedRoots: ["demo.config.json"],
        maxBudgetUsd: 2,
        timeoutMs: 6 * 60 * 1000,
        model: agentModel,
        prompt: `You are the BEAT REPAIR agent for a ${args.prospect} demo. demo.config.json is missing part of the demo's arc; fix ONLY that, with the smallest change.

${sharedRules(args.prospect, args.brief)}

What is wrong: ${problems.join("; ")}

The five beats every demo must carry, by key and in this order: ${requiredBeatKeys.join(", ")} — "generate-ui" sets \`expectsView: true\` (an imperative view-rendering prompt, never a question), "take-action" sets \`expectsApproval: true\` (a consented mutation naming one seeded sample record verbatim), "automation" makes it recurring, "connect-account" pulls in Gmail / Google Calendar / Slack, "save-app" saves the generated view as a reusable app.

Keep every beat already present exactly as it is — the pills that are there survived grounding against tools.json, which lists what this demo's agent can actually do. READ tools.json and write the missing beats over capabilities it names; a beat over a capability the demo lacks refuses in front of the prospect.

YOUR FILE LIST (writable): demo.config.json only.`,
      };
      const repair = await runAgent(repairJob, agentOptions);
      agents.push(repair);
      if (repair.code !== 0) {
        throw new Error(`Beat repair agent failed (exit ${repair.code}${repair.timedOut ? ", timed out" : ""}):\n${repair.output.slice(0, 1000)}`);
      }
      const repaired = await readAgentConfig(paths.config);
      config = repaired.config;
      merged = mergeBeats(repaired.beats, derived);
      problems = beatVarietyProblems(merged);
      if (problems.length > 0) {
        throw new Error(`demos/${args.slug}/demo.config.json still lacks the demo's arc after one repair round: ${problems.join("; ")}`);
      }
      write(`[build] beat variety repaired: ${merged.length} beat(s)`);
    }

    // Operator facts are stamped, never left to an agent's invention (a live
    // run once shipped the template's 2099 placeholder expiry). The strict
    // parse is the gate: a schema-breaking beat or placement fails HERE, not at
    // the host's next build.
    const next = await parseDemoFolderConfig(
      {
        ...config,
        id: args.slug,
        prospect: args.prospect,
        ctaUrl: args.ctaUrl,
        expiresAt: args.expiresAt,
        caps: frozenCaps,
        beats: merged,
      },
      `generated demo config at "${paths.config}"`,
    );
    await writeFile(paths.config, `${JSON.stringify(next, null, 2)}\n`);
    return next.beats;
  });

  const costUsd = agents.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  write(`[build] done: ${agents.length} agent run(s), ${toolCount} tools, ${beats.length} beats, ~$${costUsd.toFixed(2)}`);
  return { agents, toolCount, beats, costUsd };
}
