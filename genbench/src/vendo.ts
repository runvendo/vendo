import { createApps, SCREEN_FILE } from "@vendoai/apps";
import { renderBriefingPack, type BriefingPack } from "@vendoai/apps/contract";
import type { AppId, Principal, RunContext, ToolRegistry, UIPayload } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, workspaceStore } from "@vendoai/store";
import { vendoVerbsRegistry } from "@vendoai/vendo";
import { screenAssembler } from "@vendoai/vendo/server";
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
 *  reads (`contract/briefing.ts`), with the two halves a bench world has. The
 *  catalog is empty here and there is no host semantics card, exactly as the
 *  driver below composes it. */
export function worldBriefing(world: World): BriefingPack {
  return { theme: world.theme, designRules: designRules(world), catalog: [], hostSemantics: "" };
}

/**
 * The world in the words every contender is handed: the product's own design
 * brief — the theme tokens and host rules the screen assembler thinks with —
 * then each derived tool schema and the response that tool really answers with.
 *
 * ONE serializer for both baselines, because two drifted: the same world was
 * described in two formats, and only one of them said what a write tool
 * answers with. `diy.test.ts` compares this against `renderBriefingPack`,
 * `worldRegistry`'s descriptors and `worldRegistry`'s real outputs, for every
 * baseline that sends it. Each tool sits at top-level indentation on purpose —
 * nesting them in one array re-indents the schemas and there is nothing left to
 * compare byte for byte.
 */
export function worldBlock(world: World): string {
  const tools = world.tools
    .map(
      (tool) =>
        `${JSON.stringify(tool.descriptor, null, 2)}\nreturns: ${JSON.stringify(cannedResponse(tool), null, 2)}`,
    )
    .join("\n\n");
  return `${renderBriefingPack(worldBriefing(world))}

HOST TOOLS — a control on the page calls one as \`window.vendo.callTool(name, args)\`, which answers
with { status: "ok", output: <the value shown under \`returns\`> } or { status: "error", error: {
code, message } }. The call RETURNS that object synchronously — it is not a Promise, so do not
\`await\` it and do not call \`.then\` on it. \`returns\` is exactly what that call answers with, and
the only data allowed on the screen.

${tools}`;
}

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

async function run(request: RunRequest): Promise<RunOutcome> {
  // `request.signal` is not read, and it is the one column where that is true:
  // `screenAssembler` and `assemble` take no signal, so there is nowhere in
  // genbench to hand a spent case budget to. This column runs to its own finish
  // whatever the row does, and its tokens are billed either way — a product
  // change, not a harness one.
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
  let appsRef: ReturnType<typeof createApps> | undefined;
  const assembler = screenAssembler({
    models: { default: meter.model },
    tools: boundTools,
    workspace: async (screenCtx) => await workspaces.open(screenCtx.principal),
    // The floor is what paints at all: its gauntlet runs the screen's queries
    // and upserts the row. Unwired, a save paints nothing.
    render: (screenCtx) => ({
      commitSource: (input) => appsRef!.commitSource(input, screenCtx),
      floor: appsRef!.floor(screenCtx),
    }),
    briefing: async () => worldBriefing(world),
  });

  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    catalog: [],
    model: meter.model,
    theme: world.theme,
    briefing: async () => worldBriefing(world),
    screen: assembler,
  });
  appsRef = apps;
  // `apps.agentTools()` carries the data verbs, but `validate` is a vendo-verb
  // and lives one layer up (packages/vendo/src/compose-apps.ts:452). Without it
  // the screen agent's brief still tells it to "call `validate` on what you
  // saved" and the call fails, so it spends its whole step budget blind. Same
  // ports the product wires.
  const verbs = vendoVerbsRegistry({
    validate: (input, verbCtx) =>
      apps.validate(input.appId === undefined ? {} : { appId: input.appId as AppId }, verbCtx),
    schedule: async () => {
      throw new Error("genbench: the screen lane arms no schedules");
    },
  });
  const runtimeTools = apps.agentTools();
  appsTools = {
    async descriptors(listCtx) {
      return [...(await runtimeTools.descriptors(listCtx)), ...(await verbs.descriptors(listCtx))];
    },
    async execute(call, callCtx) {
      const fromVerbs = await verbs.descriptors(callCtx);
      if (fromVerbs.some((descriptor) => descriptor.name === call.tool)) return verbs.execute(call, callCtx);
      return runtimeTools.execute(call, callCtx);
    },
  };

  try {
    const outcome = await assembler.assemble(
      {
        appId,
        request: testCase.prompt,
        onView: (part) => snapshots.push({ atMs: meter.elapsedMs(), payload: part.payload }),
      },
      ctx,
    );
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
    let failure = outcome.kind === "assembled" ? undefined : outcome.why;
    if (outcome.kind === "assembled" && blocking.length > 0) {
      failure = "the delivered document does not render, so no screen is reported for it";
    }
    return {
      ...(artifact === undefined ? {} : { artifact }),
      blocking,
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
    await store.close();
  }
}
