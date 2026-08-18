import { createApps, SCREEN_FILE } from "@vendoai/apps";
import { renderBriefingPack, type BriefingPack } from "@vendoai/apps/contract";
import type { AppId, Principal, RunContext, ToolRegistry, UIPayload } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, workspaceStore } from "@vendoai/store";
import { vendoVerbsRegistry } from "@vendoai/vendo";
import { screenAssembler } from "@vendoai/vendo/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VIEWPORT } from "./render.js";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { cannedResponse, type World } from "./world.js";

const PRINCIPAL: Principal = { kind: "user", subject: "genbench" };

/** The world's tools as a registry the guard can bind. Reads answer with the
 *  case's canned rows; a write reports success without inventing a row, because
 *  nothing in a screen run should depend on its output. */
export function worldRegistry(world: World): ToolRegistry {
  return {
    async descriptors() {
      return world.tools.map((tool) => tool.descriptor);
    },
    async execute(call) {
      const tool = world.tools.find((candidate) => candidate.name === call.tool);
      if (tool === undefined) {
        return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
      }
      return { status: "ok", output: cannedResponse(tool) as never };
    },
  };
}

/** Identity plus the style rubric, in the one field the product already feeds to
 *  the briefing pack. Every contender is handed this same text. */
export function designRules(world: World): string {
  return [`${world.app}.`, "", ...world.style.map((line) => `- ${line}`)].join("\n");
}

/** THE briefing pack for a world — the product knowledge the real screen agent
 *  reads (`contract/briefing.ts`), with the two halves a bench world has. A
 *  bench world registers no host components, so the catalog is empty; the shape
 *  card is added by `vendoBriefing` and is deliberately absent here, because
 *  this is the pack `worldBlock` renders and the baselines are pinned against. */
export function worldBriefing(world: World): BriefingPack {
  return { theme: world.theme, designRules: designRules(world), catalog: [], hostSemantics: "" };
}

/**
 * The pack the vendo driver actually hands the screen agent: the shared brief,
 * plus the tool shape card.
 *
 * The card is what a deployment gets from `AppsRuntime.toolShapeBrief`
 * (`compose-surfaces.ts:113`) and a bench world has to fill itself. Without it
 * vendo was the ONE contender that had to discover tool shapes: every baseline
 * reads each descriptor in its prompt (`worldBlock`), while the screen agent
 * saw only the input schemas its loadout mounts — so it spent a paid turn
 * calling a read tool to learn what it answers with.
 *
 * The descriptors and nothing else — the same as `worldBlock` hands every other
 * column. What those fields MEAN is not spelled out for anyone: a unit stated
 * in a tool's prose is a unit every column reads for itself, and pre-digesting
 * it here would hand vendo an answer no rival was given. The canned rows stay
 * out everywhere too: a screen's data is fetched, never read out of a prompt.
 */
export function vendoBriefing(world: World): BriefingPack {
  const shapes = world.tools.map((tool) => JSON.stringify(tool.descriptor, null, 2)).join("\n\n");
  return {
    ...worldBriefing(world),
    hostSemantics: `TOOL SHAPES — every tool this host exposes, as the host declares it: what it takes,
what it returns, and whether it reads or writes.

${shapes}`,
  };
}

/**
 * The world in the words every contender is handed: the product's own design
 * brief — the theme tokens and host rules the screen assembler thinks with —
 * then each derived tool schema, and no data at all.
 *
 * The VALUES are absent on purpose, for every column. A baseline handed each
 * tool's rows in its prompt never has to fetch anything: it can paste them into
 * static markup and be right, while the vendo column spends its loop CALLING for
 * the same rows. That is two different exams under one score. Every contender now
 * gets the same access instead — the page calls `window.vendo.callTool` as it
 * renders, and a column with a working directory can call the same tools while it
 * builds ({@link installWorldTools}).
 *
 * ONE serializer for every baseline, because two drifted: the same world was
 * described in two formats, and only one of them said what a write tool
 * answers with. `diy.test.ts` compares this against `renderBriefingPack` and
 * `worldRegistry`'s descriptors, and pins that `worldRegistry`'s real outputs
 * appear NOWHERE in it, for every baseline that sends it. Each tool sits at
 * top-level indentation on purpose — nesting them in one array re-indents the
 * schemas and there is nothing left to compare byte for byte.
 */
export function worldBlock(world: World): string {
  const tools = world.tools.map((tool) => JSON.stringify(tool.descriptor, null, 2)).join("\n\n");
  return `${renderBriefingPack(worldBriefing(world))}

HOST TOOLS — the data is not written down here; a screen gets it by CALLING for it.
\`window.vendo.callTool(name, args)\` answers with { status: "ok", output: <what that tool returns> }
or { status: "error", error: { code, message } }, and it is how the page fetches what it shows.
A tool that WRITES answers { status: "pending-approval", approvalId } instead: the host confirms a
destructive call away from the screen and approves it a moment later, so a write is a round trip and
has not gone through at the moment the call returns.
The call RETURNS that object synchronously — it is not a Promise, so do not \`await\` it and do not
call \`.then\` on it, and call it while the screen renders rather than after. A tool's \`outputSchema\`
below is the shape to expect and never a value: any number, date or row that no call returned is
invented, and is graded as invented.

${tools}`;
}

/**
 * The world's tools as something an agentic column can CALL while it builds:
 * `./world-tools <name> ['<json args>']` in its working directory prints the same
 * envelope the page's bridge answers with.
 *
 * A team building this in-house has its own API in front of it while it writes
 * the screen, and the vendo column has it through its agent loop — a coding agent
 * given schemas and no way to look would be the one column building blind. The
 * arguments are accepted and ignored, exactly as `worldRegistry` and the injected
 * recorder ignore them: a world answers a tool the same way whoever asks.
 */
export const TOOL_ACCESS = `HOST TOOLS, WHILE YOU BUILD — \`./world-tools <name> ['<json args>']\` in your working
directory prints what that tool answers with, so you can see the real data before you draw anything.
The page you deliver still fetches for itself through \`window.vendo.callTool\` at render time: data
carried across from here is data the screen never asked for.`;

export async function installWorldTools(dir: string, world: World): Promise<void> {
  const answers = Object.fromEntries(world.tools.map((tool) => [tool.name, cannedResponse(tool)]));
  await writeFile(
    join(dir, "world-tools"),
    `#!/usr/bin/env node
const answers = ${JSON.stringify(answers, null, 2)};
const name = process.argv[2];
if (name === undefined || !Object.hasOwn(answers, name)) {
  console.error("world-tools: no tool " + name + " — this host exposes " + Object.keys(answers).join(", "));
  process.exit(1);
}
console.log(JSON.stringify({ status: "ok", output: answers[name] }, null, 2));
`,
    { mode: 0o755 },
  );
}

/** One verdict the product's own review gate reached, as this driver watched it
 *  go past. */
export interface Review {
  /** On the run's own clock, so a verdict can be read against the paints in
   *  `snapshots`. */
  readonly atMs: number;
  /** No BLOCKING finding — which is not the same as no findings at all: the gate
   *  grades the ask rules `warn` on purpose, and the loop repairs a warn too. */
  readonly ok: boolean;
  /** One line per finding, severity first, in the words the model was shown. */
  readonly findings: readonly string[];
}

/**
 * What the product's OWN reviewer said while this screen was being assembled.
 *
 * `result.json` used to carry the judge's verdict and nothing about how the screen
 * got there, so a failed rubric line could not be told apart from a reviewer that
 * never mentioned the defect. This is the missing half, and it costs nothing to
 * watch: the driver already fills the `validate` verb the gate is reached through
 * ({@link vendoVerbsRegistry} below), so every verdict either of its two callers
 * reached is on this list, in order — the loop's own closing review (`judgeScreen`
 * in `packages/vendo/src/screen-agent.ts`) and the agent's "validate what you
 * saved". The ones carrying the person's ask are the loop's: the model's schema
 * does not advertise `request`, so nothing else can pass it.
 *
 * THE REPAIR HALF IS NOT HERE, and cannot be from out here. Whether the round ran
 * and whether the floor accepted its bytes are `assembleScreen` internals, and
 * `ScreenOutcome` (`packages/apps/src/contract/screen.ts`) answers `assembled`
 * with a sentence and nothing else — reporting it needs a field on that contract.
 */
export interface Pipeline {
  readonly reviews: readonly Review[];
  /** A view landed AFTER the last verdict — from out here the only sign that a
   *  repair wrote something that reached the screen, and never proof it fixed
   *  anything. */
  readonly paintedAfter: boolean;
}

/** A finding as its reader gets it: what kind it is, where it is, and the
 *  teaching sentence. */
const said = (finding: { severity: string; where?: string; message: string }): string =>
  `${finding.severity}: ${finding.where === undefined ? "" : `${finding.where} — `}${finding.message}`;

export function vendoDriver(): Contender {
  return { run };
}

/** The product's own verdict on the bytes that landed — the seam's paint gate for a
 *  screen, which is the whole component gauntlet: it compiles, its imports and
 *  queries are legal, it type-checks, its queries answer, it renders, and the tree it
 *  rendered is valid. Anything here is a reason the seam would have painted nothing. */
async function blockingFindings(
  apps: ReturnType<typeof createApps>,
  appId: AppId,
  artifact: string,
  ctx: RunContext,
): Promise<string[]> {
  const painted = await apps.floor(ctx).component?.({ appId, source: artifact });
  if (painted === undefined) {
    return ["this build carries no screen engine, so nothing about the screen was checked"];
  }
  return painted.ok ? [] : [...painted.blocking];
}

/** The case's budget running out, as something a race can hold. `undefined`
 *  because it is the one thing `assemble` never answers with, so the race's
 *  result says which of the two happened. Never settles where nothing races this
 *  driver, which is the tests. */
const budgetSpent = async (signal: AbortSignal | undefined): Promise<undefined> =>
  await new Promise<undefined>((settle) => {
    if (signal === undefined) return;
    if (signal.aborted) settle(undefined);
    else signal.addEventListener("abort", () => settle(undefined), { once: true });
  });

async function run(request: RunRequest): Promise<RunOutcome> {
  // `request.signal` stops the WAIT and nothing else: `screenAssembler` and
  // `assemble` take no signal, so the assembler runs on to its own finish and
  // its tokens are billed either way — a product change, not a harness one.
  const { world, testCase, meter } = request;
  const appId = `app_${testCase.id.replaceAll("-", "_")}` as AppId;
  const ctx: RunContext = {
    principal: PRINCIPAL,
    venue: "chat",
    presence: "present",
    sessionId: `genbench_${testCase.id}`,
  };

  // Private to this case: `memory://` skips the shared single-writer lock, so a
  // distinct suffix keeps two cases from ever meeting.
  const store = createStore({ dataDir: `memory://genbench-${testCase.id}` });
  await store.ensureSchema();
  // `autopilot` because this loop can show nobody an approval card — the screen
  // agent runs non-interactive, so a parked call would just stall the run.
  const guard = createGuard({ store, policy: "autopilot" });

  // The assembly verbs (`validate`, `vendo_apps_*`) only exist once the runtime
  // does, so the registry is spliced after `createApps` returns.
  let appsTools: ToolRegistry | undefined;
  const host = worldRegistry(world);
  const combined: ToolRegistry = {
    async descriptors(listCtx) {
      return [...(await host.descriptors(listCtx)), ...(appsTools === undefined ? [] : await appsTools.descriptors(listCtx))];
    },
    async execute(call, callCtx) {
      if (world.tools.some((tool) => tool.name === call.tool)) return host.execute(call, callCtx);
      if (appsTools !== undefined) return appsTools.execute(call, callCtx);
      return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
    },
  };
  const boundTools = guard.bind(combined);

  const workspaces = workspaceStore(store);

  const snapshots: Array<{ atMs: number; payload: UIPayload }> = [];
  const reviews: Review[] = [];
  let appsRef: ReturnType<typeof createApps> | undefined;
  const assembler = screenAssembler({
    models: { default: meter.model, apps: meter.model },
    tools: boundTools,
    workspace: async (screenCtx) => await workspaces.open(screenCtx.principal),
    // The floor is what paints at all: its gauntlet runs the screen's queries
    // and upserts the row. Unwired, a save paints nothing.
    render: (screenCtx) => ({
      commitSource: (input) => appsRef!.commitSource(input, screenCtx),
      floor: appsRef!.floor(screenCtx),
    }),
    briefing: async () => vendoBriefing(world),
  });

  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    catalog: [],
    model: meter.model,
    theme: world.theme,
    briefing: async () => vendoBriefing(world),
    screen: assembler,
  });
  appsRef = apps;
  // `apps.agentTools()` carries the data verbs, but `validate` is a vendo-verb
  // and lives one layer up (packages/vendo/src/compose-apps.ts:452). Without it
  // the screen agent's brief still tells it to "call `validate` on what you
  // saved" and the call fails, so it spends its whole step budget blind. Same
  // ports the product wires.
  const verbs = vendoVerbsRegistry({
    validate: async (input, verbCtx) => {
      const verdict = await apps.validate(
        input.appId === undefined
          ? {}
          : {
              appId: input.appId as AppId,
              ...(input.request === undefined ? {} : { request: input.request }),
              ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
            },
        verbCtx,
      );
      // Read on the way past, and handed on untouched: this is the one door the
      // product's reviewer answers through, and the loop must see exactly what it
      // would have seen without an observer here ({@link Pipeline}).
      reviews.push({ atMs: meter.elapsedMs(), ok: verdict.ok, findings: verdict.findings.map(said) });
      return verdict;
    },
    schedule: async () => {
      throw new Error("genbench: the screen lane arms no schedules");
    },
  });
  const runtimeTools = apps.agentTools();
  appsTools = {
    async descriptors(listCtx) {
      // Read-risk only, and that is a FAIRNESS filter, not a permission one. The
      // screen agent equips the read verbs it needs and offers everything else
      // it was listed as a tool a button may wire (`screen-agent.ts`'s
      // `callable`), so serving the runtime's write verbs put `vendo_apps_pin`,
      // `vendo_apps_unpin`, `vendo_apps_reseed`, `vendo_apps_data_put` and
      // `vendo_apps_data_delete` in this column's brief with full schemas — ~3KB
      // of platform surface no bench case can use, and no baseline is handed
      // (`diy.test.ts`). The world's tools are the only tools any contender may
      // wire. `validate` still routes: `execute` below is untouched, and the
      // loop calls it by name rather than off this list.
      const runtime = await runtimeTools.descriptors(listCtx);
      return [...runtime.filter((descriptor) => descriptor.risk === "read"), ...(await verbs.descriptors(listCtx))];
    },
    async execute(call, callCtx) {
      const fromVerbs = await verbs.descriptors(callCtx);
      if (fromVerbs.some((descriptor) => descriptor.name === call.tool)) return verbs.execute(call, callCtx);
      return runtimeTools.execute(call, callCtx);
    },
  };

  try {
    // Whichever comes first: the assembler finishing, or the case's budget
    // running out under it. Everything below is the SAME read either way — the
    // document that landed, the product's own gate on it, and the last view it
    // painted — because a screen the person would be looking at when the bell
    // rang is a screen, and the only honest difference is the sentence saying
    // the bell rang.
    const outcome = await Promise.race([
      assembler.assemble(
        {
          appId,
          request: testCase.prompt,
          // The frame the shooter really uses, not a second copy of it: this is
          // what the screen agent is told it is writing into (`surfaceNote` in
          // `screen-agent.ts`) and what the product's own reviewer measures the
          // paint against (`paintedSection` in `component-screen.ts`). Both read
          // it off this input, so the number only has to be right once — and a
          // literal here would let this column write for a frame it is not shot in.
          viewport: { ...VIEWPORT },
          onView: (part) => snapshots.push({ atMs: meter.elapsedMs(), payload: part.payload }),
        },
        ctx,
      ),
      budgetSpent(request.signal),
    ]);
    const settledMs = meter.elapsedMs();
    // A fresh handle: the assembler's own workspace has already committed, and
    // reading through a new one is the honest read of what actually landed.
    const fresh = await workspaces.open(PRINCIPAL);
    const artifact = await fresh.readFile(`/user/apps/${appId}/${SCREEN_FILE}`).catch(() => undefined);
    // The document on disk is not always the document that painted: the agent
    // can save again after its last good view, and the seam silently keeps the
    // older screen. Re-checking the saved bytes through the product's OWN floor
    // is the only way to tell a finished screen from a stale one.
    const blocking = artifact === undefined ? [] : await blockingFindings(apps, appId, artifact, ctx);
    // `blocking` is the seam's own paint gate re-run on the bytes that landed, so
    // a non-empty list means THIS revision never reached a screen and the last
    // view belongs to an earlier save. Reporting that view here would grade a
    // screenshot against an artifact it does not describe.
    const painted = blocking.length === 0 ? snapshots.at(-1) : undefined;
    let failure =
      outcome === undefined
        ? "the case's budget ran out while this screen was still being assembled, so this is the last one it painted"
        : outcome.kind === "assembled"
          ? undefined
          : outcome.why;
    if (outcome?.kind === "assembled" && blocking.length > 0) {
      failure = "the delivered document does not render, so no screen is reported for it";
    }
    const lastReview = reviews.at(-1);
    return {
      ...(artifact === undefined ? {} : { artifact }),
      blocking,
      // What the product's own reviewer said on the way to this screen, and
      // whether anything painted after it said so ({@link Pipeline}). Absent when
      // the gate was never reached, which is a run that never saved anything.
      ...(lastReview === undefined
        ? {}
        : {
            pipeline: {
              reviews,
              paintedAfter: snapshots.some((snapshot) => snapshot.atMs > lastReview.atMs),
            },
          }),
      // The seam emits a skeleton first and the settled view last; the last one
      // is the screen a person is left looking at.
      ...(painted === undefined ? {} : { payload: painted.payload }),
      snapshots,
      // The seam only emits once a payload actually renders, so the first
      // snapshot IS first render.
      ...(snapshots[0] === undefined ? {} : { firstRenderMs: snapshots[0].atMs }),
      settledMs,
      ...(failure === undefined ? {} : { failure }),
    };
  } finally {
    // A case whose budget is already spent is still assembling — the top of this
    // function says why — and its stragglers keep writing audit rows through
    // this store after `assemble` has answered. Closing it under them turns the
    // next write into an unhandled rejection with nobody left to catch it, which
    // is what killed a whole run mid-flight. The handle is `memory://` and
    // private to this case, so leaving one open costs this process and nothing
    // else; the run's exit collects it.
    if (request.signal?.aborted === true) {
      console.warn(`genbench: ${testCase.id}'s store stays open — its assembler is still running past the case's budget`);
    } else {
      await store.close();
    }
  }
}
