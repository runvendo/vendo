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
  capabilityTokens,
  defaultChipModel,
  meaningfulTokens,
  mergeBeats,
  parseChipsReply,
  readExtractedTools,
  type ChipModelFn,
  type ExtractedTool,
} from "./chips.js";
import {
  beatSetProblems,
  demoPaths,
  parseDemoFolderConfig,
  requiredBeatKeys,
  type DemoTheme,
} from "./demo-folder.js";
import { createScrubber, defaultExec, firstLine, type ExecFn } from "./exec.js";

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
 * Per-agent spend caps, sized from a MEASURED run (three agents, $3.85 total)
 * with ~2x headroom each — not from optimism.
 *
 * They were 6/8/2 plus a 2 repair, i.e. an $18 worst case on a $3.85 job: a
 * looping agent could quintuple the cost of a run before anything noticed,
 * because `--max-budget-usd` is the ONLY thing that stops one. Screens keeps the
 * largest share; it is the fidelity-critical clone and the one live runs spend
 * most on.
 */
export const agentBudgetsUsd = { server: 4, screens: 5, beats: 1.5 } as const;
export const repairBudgetUsd = 1;
/** What a whole build stage can cost at worst. Pinned by a test. */
export const buildBudgetCeilingUsd = agentBudgetsUsd.server + agentBudgetsUsd.screens + agentBudgetsUsd.beats + repairBudgetUsd;

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
- theme.json already holds the exact brand tokens and the host turns them into Tailwind colours: use \`bg-bg\`, \`bg-surface\`, \`text-ink\`, \`text-muted\`, \`border-border\`, \`bg-accent\`, \`text-accent-ink\`, \`text-danger\`. Never a hardcoded hex — a hex is the one thing that cannot be re-themed.
- NEVER import from \`@vendoai/*\`. The host's manifest step rejects it and the build fails: everything Vendo arrives through \`@host/vendo-kit\`, already themed and already pointed at this slug's wire.`;
}

/** "bank-transactions" → "BankTransactions". */
function pascal(stem: string): string {
  return stem.split(/[^a-z0-9]+/i).filter((part) => part !== "").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

/**
 * The EXACT functions server/entities.ts exports and screens/index.tsx imports.
 *
 * Both are written by different agents, at the same time, from the same brief —
 * so the names cannot be left to either one's taste. A live run proved it: the
 * server agent derived `listLicenses` from the entity's stem while the screens
 * agent derived `listVendorLicenses` from its name, and the host build failed on
 * "export listVendorLicenses was not found" after ten minutes of generation.
 * The list name comes off the STEM because a stem is already the plural
 * ("licenses"), where pluralising a PascalCase name is guesswork ("Entry" →
 * "Entrys").
 */
export function domainApi(brief: BrandBrief): { list: string; get: string; action: string; name: string }[] {
  return brief.entities.map((entity) => ({
    name: entity.name,
    list: `list${pascal(entity.stem)}`,
    get: `get${entity.name}`,
    action: entity.action,
  }));
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
      maxBudgetUsd: agentBudgetsUsd.server,
      timeoutMs: 20 * 60 * 1000,
      model: agentModel,
      prompt: `You are the SERVER agent for a ${prospect} demo. You write the demo's domain: its data, its routes, and the OpenAPI spec those routes are extracted from.

${rules}

THE DOMAIN (from BRIEF.md — implement it exactly):
${entities}

Read demos/_example/server/ in this same repo FIRST — it is the host's own worked example of every file you are about to write, and copying its shape is the fastest way to a demo that compiles.

YOUR TASK (four files, exactly these shapes — the host imports them by name):
- server/seed.ts: \`export interface SeedData\` and \`export function buildSeed(anchor: Date = new Date()): SeedData\`. Import the seeded prng as \`import { mulberry32 } from "@host/prng"\` — never Math.random, and derive every date from \`anchor\` rather than the clock, or the demo looks different on every boot. 10-20 records per entity: right magnitudes, coherent dates (created before updated, nothing after the anchor), a realistic status spread.
- The sample records above must seed in a state the mutating action can STILL act on — not already archived, closed, voided or paid. A beat names one of them, and an already-actioned record makes the agent correctly decline: no consent card appears and the beat dies in front of the prospect. Pin their state explicitly instead of leaving it to the prng.
- server/store.ts: exactly \`import { storeFor } from "@host/server/demo-store"\`, \`import { buildSeed } from "./seed"\`, \`export const getStore = () => storeFor(buildSeed)\`. Nothing else. This is load-bearing: a plain module singleton is instantiated ONCE PER ROUTE BUNDLE in a production Next build, so the page and the API would hold different copies and an approved mutation would visibly not happen on the page. \`storeFor\` is the host's one keyed store.
- server/entities.ts: the domain types above, plus the read and write functions the page and the routes both call. Export these names EXACTLY — the screens agent is importing them from this file RIGHT NOW and a different name fails the host build:
${domainApi(brief).map((api) => `  · \`${api.list}(): ${api.name}[]\`, \`${api.get}(id: string): ${api.name} | undefined\`, \`${api.action}(id: string): ${api.name}\``).join("\n")}
  They reach the data through \`getStore()\` from ./store. Throw a named error class for "no such record" so routes can answer 404. One mutation each, nothing speculative.
- server/routes.ts: \`import type { DemoRoutes } from "@host/lib/demo-module"\` and \`export const routes: DemoRoutes\`. Keys are \`"METHOD /path"\` where path is what follows \`/api/<slug>\`, e.g. \`"GET /${brief.entities[0]?.stem ?? "records"}"\` and \`"POST /${brief.entities[0]?.stem ?? "records"}/:id/${brief.entities[0]?.action ?? "act"}"\`. A handler takes \`(request: Request)\` — NOT a store argument — and reads captured \`:name\` segments as SEARCH PARAMS (\`new URL(request.url).searchParams.get("id")\`), because that is how the host passes them. Answer \`Response.json({ data: ... })\` on success and \`Response.json({ error: { message, code } }, { status })\` on failure, exactly like demos/_example. That envelope must be what openapi.json describes: a shape the spec does not describe is a shape the agent mis-reads, and the pill dead-ends in front of the prospect.
- openapi.json: declare EVERY route in routes.ts — matching operationId, a one-sentence summary in the product's own words, path/query parameters with descriptions, the \`{ data: ... }\` response schema, and x-vendo-formats for money fields stored in cents.

openapi.json is the ONLY source of the demo agent's tools: a route missing from the spec does not exist to the agent. It needs at least one list route AND at least one mutating route, or the demo has nothing to show.

YOUR FILE LIST (writable): server/seed.ts, server/store.ts, server/entities.ts, server/routes.ts, openapi.json.`,
    },
    {
      name: "screens",
      ownedRoots: ["screens"],
      maxBudgetUsd: agentBudgetsUsd.screens,
      timeoutMs: 20 * 60 * 1000,
      model: agentModel,
      prompt: `You are the SCREENS agent for a ${prospect} demo. You write the product page — a 1:1 clone of the reference screenshot, and the fidelity-critical surface the judge scores.

${rules}

THE DOMAIN (another agent is writing server/ from the same brief, concurrently):
${entities}

Read demos/_example/screens/index.tsx in this same repo FIRST: it is the host's own worked example, and what must survive your rewrite is its SHAPE — a server component with no props, reading data through ../server, rendering the kit's surfaces.

YOUR TASK:
- screens/index.tsx default-exports the product page as a SERVER component (no "use client"). It receives NO props. It reads the demo's data through the domain functions another agent is writing in \`../server/entities\` RIGHT NOW, and NEVER by fetching (a screen that fetched and guessed the route's envelope shipped once as a perfect-looking report page that listed nothing at all). Import EXACTLY these names — inventing a variant fails the host build:
  \`import { ${domainApi(brief).map((api) => api.list).join(", ")} } from "../server/entities"\`
- The page is a STRUCTURAL 1:1 clone of ${brief.referenceScreenshot}: same regions, same nav labels (${brief.nav.join(" · ")}), same column set, same header composition, same density — populated from the seeded ${brief.entities.map((entity) => entity.name).join(" / ")} records. ${brief.productSurface}
- You may add sibling components under screens/ and import them.
- Render the Vendo surfaces where BRIEF.md's placement says: trigger in the ${brief.placement.trigger}, ${brief.placement.slot}. Import them ONLY from \`@host/vendo-kit\`, which exports exactly: VendoTrigger, VendoSlot, VendoPage, VendoThread, VendoOverlay, VendoActivities, useDemo. \`<VendoTrigger prompt="...">Label</VendoTrigger>\` is the entry point and \`<VendoSlot id="..." />\` is where a generated view lands. VendoRoot and the overlay layer are mounted by the HOST around your page — do not mount them yourself, and never re-implement a surface: the kit arrives themed for this demo and pointed at this slug's wire.

YOUR FILE LIST (writable): screens/** only.`,
    },
    {
      name: "beats",
      ownedRoots: ["demo.config.json"],
      maxBudgetUsd: agentBudgetsUsd.beats,
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

LANGUAGE — if ${prospect}'s product is NOT in English (the chip material and entity names above are your evidence), also write \`strings\`, which is how the host's own chrome stops speaking English over their product. Translate these into the SAME language and register as your beats, and omit the whole block for an English product:
{ "locale": "<BCP-47, e.g. es>", "triggerLabel": "<'Ask ${prospect}'>", "slotTitle": "<'This space builds itself'>", "slotSubtitle": "<'describe a view — it renders here, live on your data'>", "slotCtaLabel": "<'Design a view'>", "threadGreeting": "<'What can I help you build?'>" }
These six keys are the ONLY ones allowed. The watermark, the "Get this in your product" CTA and the limit/expired card stay in English on purpose — they disclose that this is a Vendo demo on sample data, so never translate them and never add a key for them; the schema rejects it.

The pipeline stamps id, prospect, ctaUrl, expiresAt and caps over whatever you write — those are operator facts, not yours to invent. Write them as placeholders and move on.

tools.json does not exist yet: it is generated from the OpenAPI spec the server agent is writing right now, so you cannot check your pills against the real tool surface. The pipeline grounds them against it the moment you finish, and a pill it cannot ground is dropped. So stay inside the chip material and the entity actions above — those are the capabilities the server agent is being told to build.

YOUR FILE LIST (writable): demo.config.json only.`,
    },
  ];
  assertDisjointOwnership(jobs);
  return jobs;
}

// ---------------------------------------------------------------------------
// Grounding the authored beats
// ---------------------------------------------------------------------------

/**
 * Beats that exercise VENDO's own capabilities rather than one of the demo's
 * host tools. Nothing in tools.json describes connecting a Gmail account or
 * saving a generated view as an app, so demanding tool-surface overlap for
 * these two would reject beats that are perfectly correct.
 */
export const platformBeatKeys = new Set<string>(["connect-account", "save-app"]);

/**
 * The authored beats that say nothing the demo's real tool surface can do.
 *
 * The beats agent writes its pills BEFORE tools.json exists — that is what lets
 * the three build agents run in parallel — so this is the ONLY place where the
 * pills a prospect actually clicks meet the capabilities the demo actually has.
 * The test is deliberately the same one chips.ts applies to a derived pill: at
 * least one meaningful word shared with some capability's name or description.
 * A pill about invoices in a demo whose tools are all about shipments refuses
 * the moment a prospect clicks it.
 */
export function ungroundedBeats(beats: readonly DemoBeat[], tools: readonly ExtractedTool[]): DemoBeat[] {
  const surface = subjectTokens(tools);
  return beats.filter((beat) => {
    if (platformBeatKeys.has(beat.key)) return false;
    for (const token of meaningfulTokens(`${beat.chip} ${beat.prompt}`)) {
      if (surface.has(token)) return false;
    }
    return true;
  });
}

/**
 * The operation verbs every CRUD surface shares. They are dropped from the
 * comparison because they ground nothing: "Show me every overdue invoice"
 * shares "list" and "every" with a tool called `host_listShipments` whose
 * description reads "List every shipment", and that overlap would pass a pill
 * about invoices in a demo that only knows about shipments — the exact failure
 * this check exists to catch.
 */
const operationVerbs = new Set([
  "list", "get", "fetch", "read", "show", "search", "find", "query",
  "create", "add", "update", "edit", "set", "change", "remove", "delete", "every", "record", "item", "data",
]);

/** What the demo's tools are ABOUT: the nouns in their names and prose, minus
 * the CRUD verbs. A tool's name is its identity, so it is weighted in by
 * being included at all — the description only adds subject nouns. */
function subjectTokens(tools: readonly ExtractedTool[]): Set<string> {
  const subjects = new Set<string>();
  for (const tool of tools) {
    for (const token of capabilityTokens(tool)) {
      if (!operationVerbs.has(token)) subjects.add(token);
    }
  }
  return subjects;
}

/**
 * Words that make a prompt RECURRING. The automation beat's whole point is that
 * it sets something up rather than doing it once, and a derived pill knows
 * nothing about beat kinds — so a pill without one of these cannot stand in for
 * it. Deliberately generous: a false "this is recurring" only costs the wording
 * we already had, while a false negative sends the beat to the repair agent,
 * which is the honest path.
 */
const recurrencePatterns = [
  // "every" alone means nothing here: "show me every shipment" is a one-off
  // view. It has to be every <time>.
  /\bevery (mon|tues|wednes|thurs|fri|satur|sun)day\b/,
  /\bevery (day|week|month|morning|hour|quarter|time)\b/,
  /\beach (day|week|month|morning|quarter)\b/,
  /\b(daily|weekly|monthly|hourly|quarterly|recurring|automatically|automate[sd]?|schedule[sd]?|ongoing)\b/,
  /\bwhenever\b/,
  /\bfrom now on\b/,
];

function readsAsRecurring(beat: DemoBeat): boolean {
  const text = `${beat.chip} ${beat.prompt}`.toLowerCase();
  return recurrencePatterns.some((pattern) => pattern.test(text));
}

/**
 * Rewrites each ungrounded beat's visible text with a derived pill, keeping its
 * key and its expectation flags — the arc (`generate-ui` must still render a
 * view, `take-action` must still ask for consent) belongs to the pipeline, only
 * the wording belongs to the model.
 *
 * A swap must not change the beat's KIND. Handing the `automation` beat a
 * one-off pill kept the key, so the beat-set check still "passed", and shipped
 * an automation chip that automates nothing — so a pill that does not read as
 * recurring is refused and the beat goes to the repair agent instead.
 *
 * `consumed` is the pills that were spent here: merging must not append them
 * again, or the same sentence reaches the strip twice under two keys.
 */
export function regroundBeats(
  beats: readonly DemoBeat[],
  tools: readonly ExtractedTool[],
  derived: readonly DemoBeat[],
): { beats: DemoBeat[]; replaced: string[]; stillUngrounded: string[]; consumed: DemoBeat[] } {
  const ungrounded = new Set(ungroundedBeats(beats, tools).map((beat) => beat.key));
  const spare = derived.filter((pill) => ungroundedBeats([pill], tools).length === 0);
  const replaced: string[] = [];
  const stillUngrounded: string[] = [];
  const consumed: DemoBeat[] = [];
  const taken = new Set<DemoBeat>();
  const result = beats.map((beat) => {
    if (!ungrounded.has(beat.key)) return beat;
    const pill = spare.find((candidate) => !taken.has(candidate)
      && (beat.key !== "automation" || readsAsRecurring(candidate)));
    if (pill === undefined) {
      stillUngrounded.push(beat.key);
      return beat;
    }
    taken.add(pill);
    consumed.push(pill);
    replaced.push(beat.key);
    return { ...beat, chip: pill.chip, prompt: pill.prompt };
  });
  return { beats: result, replaced, stillUngrounded, consumed };
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
  /** Only the scrubber reads it — the CLI's own failures are relayed verbatim. */
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const paths = demoPaths(options.demosRepo, options.slug);
  const scrub = createScrubber(options.env ?? process.env);
  const result = await options.exec(
    ["node", vendoCli, "sync", paths.root, "--no-watermark"],
    { cwd: paths.root, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  if (result.code !== 0) {
    throw new Error(`vendo sync failed (exit ${result.code}) over demos/${options.slug}: ${scrub(firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output")}`);
  }

  // `vendoSync` defaults its `out` to `<root>/.vendo` and also drops a
  // catalog.json there. The frozen folder contract puts tools.json at the demo
  // root, and a stray .vendo/ would be committed into the host repo — so move
  // the one file we keep and delete the rest.
  const vendoDir = path.join(paths.root, ".vendo");
  try {
    const count = (await readExtractedTools(path.join(vendoDir, "tools.json"))).length;
    if (count === 0) {
      throw new Error(`vendo sync extracted no product tools from demos/${options.slug}/openapi.json — a demo whose agent can do nothing is not shippable (if the spec looks right, check that tools.json parsed: a malformed one reads as empty)`);
    }
    await rename(path.join(vendoDir, "tools.json"), paths.tools);
    return count;
  } finally {
    // In a `finally` because the throw above is exactly when the leftovers
    // matter most: a re-run or a later `demo:fix` does `git add -- demos/<slug>`
    // and would commit the stray directory into the host repo.
    await rm(vendoDir, { recursive: true, force: true });
  }
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
 * Writes JSON so a reader never sees half of it.
 *
 * demo.config.json is overwritten twice in this stage — once with the
 * known-invalid merged state so the repair agent can SEE it, once with the final
 * config — and a plain in-place write that fails mid-flight leaves truncated
 * JSON. Every later reader (the repair agent, `demo:fix`, the host build) then
 * fails to parse it for a reason that has nothing to do with the demo.
 *
 * The temp file is a sibling, not in os.tmpdir(): `rename` is only atomic within
 * one filesystem. Serialise BEFORE opening anything, so a value that cannot be
 * stringified never touches disk.
 */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, body);
    await rename(temporary, target);
  } finally {
    // A leftover temp file inside the demo folder would be committed to the host
    // repo by ship's `git add -- demos/<slug>`.
    await rm(temporary, { force: true });
  }
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
  // A generation agent that hit a credential error quotes it back in its final
  // message, and that message goes straight into an operator-visible throw.
  const scrub = createScrubber(env);
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const paths = demoPaths(io.demosRepo, args.slug);
  // The harness box, not the prompt: writes land inside this demo folder or the
  // claude CLI refuses them (agent.ts's buildSandboxSettings).
  const sandbox = { writeRoot: paths.root, readRoot: io.demosRepo };
  const agentOptions = { cwd: paths.root, env, sandbox, ...(io.signal === undefined ? {} : { signal: io.signal }) };
  const agents: AgentRunResult[] = [];

  const recordAgent = (result: AgentRunResult): void => {
    agents.push(result);
    write(`[build] agent ${result.name}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""} ($${result.costUsd?.toFixed(2) ?? "?"})`);
    if (result.permissionDenials.length > 0) {
      write(`[build] agent ${result.name}: the harness DENIED ${result.permissionDenials.length} write(s) outside its box: ${result.permissionDenials.join(", ")}`);
    }
  };

  await runStage("build:agents", async () => {
    const jobs = buildAgentJobs({
      slug: args.slug,
      prospect: args.prospect,
      brief: args.brief,
      ctaUrl: args.ctaUrl,
      expiresAt: args.expiresAt,
    });
    write(`[build] ${jobs.map((job) => job.name).join(", ")} in parallel over demos/${args.slug} (brand font ${args.theme.typography.fontFamily})`);
    // One agent failing ABORTS its siblings. `Promise.all` alone is fail-fast on
    // the await only: the other two claude processes keep editing the same demo
    // folder for up to twenty more minutes, after the run has already failed —
    // and they can be mid-write when the operator starts looking at it.
    const fanOut = new AbortController();
    const onCapAbort = (): void => fanOut.abort(io.signal?.reason);
    io.signal?.addEventListener("abort", onCapAbort, { once: true });
    const results: AgentRunResult[] = [];
    try {
      await Promise.all(jobs.map(async (job) => {
        // ownedRoots ride the SANDBOX, not just the prompt: three agents editing
        // one folder in parallel, and the harness is what stops two of them
        // deciding to own the same file.
        const result = await runAgent(job, {
          ...agentOptions,
          sandbox: { ...sandbox, ownedRoots: job.ownedRoots },
          signal: fanOut.signal,
        });
        results.push(result);
        if (result.code !== 0) fanOut.abort(new Error(`build agent "${result.name}" failed (exit ${result.code})`));
      }));
    } finally {
      io.signal?.removeEventListener("abort", onCapAbort);
      // Whatever the outcome, no sibling is left running: a rejected spawn
      // (agent.ts's spawn-error path) unwinds this without any result at all.
      fanOut.abort(new Error("the build fan-out ended"));
      for (const result of results) recordAgent(result);
    }
    const failed = results.filter((result) => result.code !== 0);
    if (failed.length > 0) {
      throw new Error(`${failed.length} build agent(s) failed: ${failed.map((result) => `${result.name} (exit ${result.code}${result.timedOut ? ", timed out" : ""})`).join(", ")}\nFirst failure output:\n${scrub(failed[0]?.output.slice(0, 1000) ?? "")}`);
    }
  });

  const toolCount = await runStage("build:sync", async () => {
    const count = await syncTools({
      demosRepo: io.demosRepo,
      slug: args.slug,
      exec,
      env,
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

    /**
     * Ground a config's beats and report every problem with the resulting set.
     *
     * ONE function because it runs TWICE — before and after the repair round.
     * The old post-repair pass recomputed beat variety only, and since a repair
     * round is triggered by grounding failures too, that is precisely the run
     * where an ungrounded pill shipped: the re-check could not see it.
     */
    const groundAndCheck = (beats: readonly DemoBeat[]): { beats: DemoBeat[]; problems: string[] } => {
      // The authored pills are checked against the surface FIRST — they are what
      // a prospect clicks. A derived pill is not an extra pill; it is the
      // replacement wording for an authored one that named a capability this
      // demo does not have. Only then does mergeBeats fill a short arc, with the
      // pills regrounding already spent excluded.
      const reground = regroundBeats(beats, tools, derived);
      const spare = derived.filter((pill) => !reground.consumed.includes(pill));
      const merged = mergeBeats(reground.beats, spare);
      write(`[build] grounding: ${tools.length} tool(s); ${reground.replaced.length === 0 ? "every authored pill was grounded" : `regrounded ${reground.replaced.join(", ")}`}${reground.stillUngrounded.length === 0 ? "" : `; STILL ungrounded: ${reground.stillUngrounded.join(", ")}`}; ${merged.length} beat(s)`);
      return {
        beats: merged,
        problems: [
          ...beatSetProblems(merged),
          ...reground.stillUngrounded.map((key) => `beat "${key}" names no capability in tools.json`),
        ],
      };
    };

    const first = groundAndCheck(authored.beats);
    let merged = first.beats;
    let problems = first.problems;
    if (problems.length > 0) {
      // The repair agent edits the file, so it has to SEE the merged state —
      // including the derived pills — rather than the config it wrote itself.
      await writeJsonAtomic(paths.config, { ...config, beats: merged });
      write(`[build] beat variety: ${problems.join("; ")} — one repair agent`);
      const repairJob: AgentJob = {
        name: "beats-repair",
        ownedRoots: ["demo.config.json"],
        maxBudgetUsd: repairBudgetUsd,
        timeoutMs: 6 * 60 * 1000,
        model: agentModel,
        prompt: `You are the BEAT REPAIR agent for a ${args.prospect} demo. demo.config.json is missing part of the demo's arc; fix ONLY that, with the smallest change.

${sharedRules(args.prospect, args.brief)}

What is wrong: ${problems.join("; ")}

The five beats every demo must carry, by key and in this order: ${requiredBeatKeys.join(", ")} — "generate-ui" sets \`expectsView: true\` (an imperative view-rendering prompt, never a question), "take-action" sets \`expectsApproval: true\` (a consented mutation naming one seeded sample record verbatim), "automation" makes it recurring, "connect-account" pulls in Gmail / Google Calendar / Slack, "save-app" saves the generated view as a reusable app.

Keep every beat already present exactly as it is — the pills that are there survived grounding against tools.json, which lists what this demo's agent can actually do. READ tools.json and write the missing beats over capabilities it names; a beat over a capability the demo lacks refuses in front of the prospect.

YOUR FILE LIST (writable): demo.config.json only.`,
      };
      const repair = await runAgent(repairJob, {
        ...agentOptions,
        sandbox: { ...sandbox, ownedRoots: repairJob.ownedRoots },
      });
      recordAgent(repair);
      if (repair.code !== 0) {
        throw new Error(`Beat repair agent failed (exit ${repair.code}${repair.timedOut ? ", timed out" : ""}):\n${scrub(repair.output.slice(0, 1000))}`);
      }
      const repaired = await readAgentConfig(paths.config);
      config = repaired.config;
      const second = groundAndCheck(repaired.beats);
      merged = second.beats;
      problems = second.problems;
      if (problems.length > 0) {
        throw new Error(`demos/${args.slug}/demo.config.json still does not satisfy the beat contract after one repair round: ${problems.join("; ")}`);
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
    await writeJsonAtomic(paths.config, next);
    return next.beats;
  });

  const costUsd = agents.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  write(`[build] done: ${agents.length} agent run(s), ${toolCount} tools, ${beats.length} beats, ~$${costUsd.toFixed(2)}`);
  return { agents, toolCount, beats, costUsd };
}
