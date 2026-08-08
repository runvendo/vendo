import { createApps, hostDesignBrief } from "@vendoai/apps";
import type { AppId, Principal, RunContext, ToolRegistry, UIPayload, WorkspaceFs } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { screenAssembler } from "@vendoai/harnesses";
import { createStore, workspaceStore } from "@vendoai/store";
import { vendoVerbsRegistry } from "@vendoai/vendo";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import type { World } from "./world.js";

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
      return { status: "ok", output: (tool.data ?? { ok: true }) as never };
    },
  };
}

/** Identity plus the style rubric, in the one field the product already feeds to
 *  `hostDesignBrief`. Every contender is handed this same text. */
export function designRules(world: World): string {
  return [`${world.app}.`, "", ...world.style.map((line) => `- ${line}`)].join("\n");
}

export function vendoDriver(): Contender {
  return { harness: "vendo", run };
}

/** The product's own verdict on the bytes that landed: `block` findings are
 *  exactly what the render seam refuses to paint on. */
async function blockingFindings(
  apps: ReturnType<typeof createApps>,
  appId: AppId,
  artifact: string,
  ctx: RunContext,
): Promise<string[]> {
  const floor = apps.floor(ctx);
  const compiled = await floor.compile(artifact);
  if (compiled.issues.some((issue) => issue.code === "compile-failed" || issue.code === "missing-app")) {
    return compiled.issues.map((issue) => `${issue.code}: ${issue.message}`);
  }
  const findings = await floor.check({ appId, compiled });
  return findings.filter((finding) => finding.severity === "block").map((finding) => finding.message);
}

async function run(request: RunRequest): Promise<RunOutcome> {
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
  const screenWorkspace = async (screenCtx: RunContext): Promise<WorkspaceFs> =>
    await workspaces.open(screenCtx.principal);

  const snapshots: Array<{ atMs: number; payload: UIPayload }> = [];
  let appsRef: ReturnType<typeof createApps> | undefined;
  const assembler = screenAssembler({
    models: { default: meter.model },
    tools: boundTools,
    workspace: screenWorkspace,
    // Wiring all three halves is what makes the emitted payload carry REAL
    // resolved query data; unwired, the seam falls back to a bare compile and
    // paints blank values.
    render: (screenCtx) => ({
      authoredApp: (input) => appsRef!.authored(input, screenCtx),
      commitSource: (input) => appsRef!.commitSource(input, screenCtx),
      floor: appsRef!.floor(screenCtx),
    }),
    design: () => hostDesignBrief({ theme: world.theme, designRules: designRules(world) }),
  });

  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    catalog: [],
    model: meter.model,
    theme: world.theme,
    designRules: designRules(world),
    screen: assembler,
  });
  appsRef = apps;
  // `apps.agentTools()` carries the data verbs, but `validate` is a vendo-verb
  // and lives one layer up (packages/vendo/src/compose-apps.ts:452). Without it
  // the screen agent's brief still tells it to "call `validate` on what you
  // saved" and the call fails, so it spends its whole step budget blind. Same
  // ports the product wires; the catalog is empty here, so the component search
  // has nothing to find.
  const verbs = vendoVerbsRegistry({
    validate: (input, verbCtx) =>
      apps.validate(
        {
          ...(input.appId === undefined ? {} : { appId: input.appId as AppId }),
          ...(input.document === undefined ? {} : { document: input.document }),
        },
        verbCtx,
      ),
    searchComponents: async () => [],
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
    const artifact = await fresh.readFile(`/user/apps/${appId}/app.vendo`).catch(() => undefined);
    // The document on disk is not always the document that painted: the agent
    // can save again after its last good view, and the seam silently keeps the
    // older screen. Re-checking the saved bytes through the product's OWN floor
    // is the only way to tell a finished screen from a stale one.
    const blocking = artifact === undefined ? [] : await blockingFindings(apps, appId, artifact, ctx);
    return {
      ...(artifact === undefined ? {} : { artifact }),
      blocking,
      // The seam emits a skeleton first and the settled view last; the last one
      // is the screen a person is left looking at.
      ...(snapshots.at(-1) === undefined ? {} : { payload: snapshots.at(-1)!.payload }),
      snapshots,
      // The seam only emits once a payload actually renders, so the first
      // snapshot IS first render.
      ...(snapshots[0] === undefined ? {} : { firstRenderMs: snapshots[0].atMs }),
      settledMs,
      ...(outcome.kind === "assembled" ? {} : { failure: outcome.why }),
    };
  } finally {
    await store.close();
  }
}
