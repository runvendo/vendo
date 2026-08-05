/**
 * The screen agent — UI-generation blueprint §4.2 and §4.5.
 *
 * The same `startTurn` loop `vendo()` and `instant()` drive, with a SMALL loadout
 * and a tight step budget: assembly tools only, the catalog and the host's own
 * declared result shapes in the brief, its own file hands, and one `escalate`
 * tool. It is the cheap first pass in front of the conductor — "every request
 * starts in the screen agent" (§1 point 2) — and nothing about it is new
 * machinery:
 *
 * - **The write path is `turn.workspace`.** The `claudeCode()` harness already
 *   builds apps this way: the model writes `plan.vendo` / `app.vendo` with its own
 *   hands and the runtime's commit is what makes it real
 *   (`claude-code/index.ts:338`, `skills/building-apps.ts:68`). This agent has no
 *   disk and no shell, so the two files it may write are two tools over the same
 *   `WorkspaceFs`. There is no third writer.
 * - **The paint path is the render seam.** `wrapWorkspaceForRender` intercepts
 *   `commit()`, compiles, and emits `data-vendo-view`. This file never emits a
 *   view and never compiles anything — that is exactly why a screen it assembles
 *   passes the same floor a `claudeCode()` app does.
 * - **`vendo_make` is withheld, not merely unused.** The screen agent IS what
 *   `vendo_make` calls, so leaving it callable is a loop. The `Harness` door
 *   withholds it at `toolSurface` (the runtime answers a withheld name with the
 *   same `not-found` a typo gets); the assembler door never projects it. Both
 *   matter, because `isAlwaysActive` in the loadout is `name.startsWith("vendo_")`
 *   — a `vendo_`-prefixed tool cannot be gated by `activeTools` at all.
 * - **The job description is the shipped skill.** `buildingAppsSkill` plus its
 *   `references/format.md` are the same text `claudeCode()` reads. This file adds
 *   one short block that corrects the ENVIRONMENT (no disk, no delegation, two
 *   files, one door out) rather than restating the job — a third prompt is the
 *   thing §0 forbids.
 *
 * Screens run UNSANDBOXED, by §6.5: a description is data, its props are
 * schema-validated, and the kit treats them as inert. There is no box here.
 */
import {
  VENDO_MAKE_TOOL,
  type AppId,
  type Json,
  type SeatModels,
  type RunContext,
  type ScreenAssembler,
  type ScreenOutcome,
  type ScreenRequest,
  type ToolListing,
  type ToolRegistry,
  type TurnTools,
  type WorkspaceFs,
  type Harness,
  type Turn,
  modelToolDescription,
} from "@vendoai/core";
import { startTurn, wireErrorMessage } from "@vendoai/agent/internal";
import { buildingAppsSkill } from "@vendoai/apps";
import { jsonSchema, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { defineHarness } from "./define.js";
import { wrapWorkspaceForRender, type RenderSeamOptions } from "./render-seam.js";

/**
 * The whole budget for assembling one screen.
 *
 * Sized off the work, not off a round number: learn a shape or search the
 * catalog (1–2), save the app (1–3, because saving as you go is what makes it
 * grow on screen), `validate` and fix what it reports (2–3), and one step to
 * speak. `instant()`'s `ACT_STEPS = 2` is a specialist that must not think;
 * `DEFAULT_MAX_STEPS = 20` is a resident that may. A screen is neither, and the
 * cap is the definition of "cheap": an ask that needs more than this is an ask
 * for a BUILD, and `escalate` is the honest exit rather than a bigger number.
 */
export const SCREEN_STEPS = 10;

/** The one door out of assembly (§4.5). Never `vendo_`-prefixed: the loadout's
 *  `isAlwaysActive` would make it un-gateable, and this tool is the screen
 *  agent's own, not a product capability anybody else may reach. */
export const ESCALATE_TOOL = "escalate";

/** The file hands. Two files, so two tools and no path argument — a screen agent
 *  has exactly one app directory, and a tool that takes a path is a tool that can
 *  write outside it. */
export const SAVE_APP_TOOL = "save_app";

/**
 * The assembly verbs, by NAME rather than by risk.
 *
 * `validate` and `search_components` are graded `write` on purpose — design §12's
 * mechanical vote fail-closes a name ending in a noun (`vendo-verbs.ts:41-48`) —
 * so a `risk === "read"` filter would drop the two tools the whole loop is built
 * around. Host read tools come in by risk below; these come in by name.
 */
const ASSEMBLY_TOOLS: readonly string[] = [
  "search_components",
  "validate",
  "vendo_apps_data_list",
  "vendo_apps_open",
  "ask_user",
];

/** A tool with no declared input still needs a schema the provider will accept. */
const NO_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/**
 * What the lean loop needs, and nothing else.
 *
 * A `Turn` satisfies this by construction — structurally, with no adapter and no
 * wrapper — which is what lets the `Harness` door and the `vendo_make` door share
 * ONE loop instead of growing a second copy of it. Composition's door builds the
 * same four fields out of the pieces it already holds.
 */
export interface ScreenSurface {
  readonly models: SeatModels<LanguageModel>;
  readonly tools: TurnTools;
  /** Wrapped by the render seam before it gets here, so `commit()` paints. */
  readonly workspace: WorkspaceFs;
  readonly signal: AbortSignal;
}

export interface ScreenInput {
  /** The app whose files this run writes. Minted by the caller so the file path,
   *  the view's stream id and any receipt all name the same app. */
  appId: AppId;
  /** The person's ask, verbatim. */
  request: string;
  /** The deployment's assembled prompt, when there is one — prepended, so the
   *  host's voice and the guard's directions are not lost to the job description. */
  system?: string;
}

/** What one assembly run answers. `ScreenOutcome` plus the title an assembled
 *  screen named itself, which the front door turns into a receipt. */
export type ScreenResult = ScreenOutcome & { title?: string };

const APP_FILE = "app.vendo";
const PLAN_FILE = "plan.vendo";

/** §3.1's frozen layout, personal mount. A NEW app is always `/user/**`: a fresh
 *  `/orgs/<org>/apps/<id>/` path has no row to grant on, so the workspace façade
 *  refuses the commit and the file never lands (see `AppsRuntime.authored`). */
const appDirectory = (appId: AppId): string => `/user/apps/${appId}`;

/** The app's own name, off the document it just wrote. Presentation only — the
 *  receipt's `title` — so a file that has not named itself yet is simply absent
 *  rather than a reason to fail. */
const nameOf = (content: string): string | undefined => {
  const match = /<App\b[^>]*\bname="([^"]+)"/.exec(content);
  return match?.[1]?.trim() || undefined;
};

/**
 * The host's surface, as the model reads it before writing a single binding.
 *
 * `ToolListing.outputSchema` is the host's OWN declared result shape, captured by
 * extraction and threaded onto the listing precisely so "the model reads field
 * names off the listing instead of calling a query once to learn them"
 * (`turn-tools.ts:236-253`). That is the catalog half AND the shape half for
 * every tool that declares one; for the rest the skill's own rule applies — call
 * it once. No sampler is written here: the create-time probe
 * (`AppsRuntime.generationToolContext`) is the conductor's and stays there.
 */
function toolBrief(listings: readonly ToolListing[]): string {
  if (listings.length === 0) return "This product has no tools you can read data from.";
  return listings
    .map((listing) => {
      const shape = listing.outputSchema === undefined
        ? ""
        : `\n  returns: ${JSON.stringify(listing.outputSchema)}`;
      const input = listing.inputSchema === undefined
        ? ""
        : `\n  input: ${JSON.stringify(listing.inputSchema)}`;
      return `- ${listing.name} — ${modelToolDescription(listing)}${input}${shape}`;
    })
    .join("\n");
}

/**
 * The environment correction, and only that.
 *
 * The shipped skill is written for a reader with a machine: a `Task` tool, a
 * `host/components/` directory, a `references/format.md` on disk, "edit the text
 * in place". None of those exist here. So these lines say what is different and
 * the skill says what the job is — which is the difference between deriving a
 * brief and forking one.
 */
const environmentNote = (appId: AppId, listings: readonly ToolListing[]): string => `# In this loop

You have no machine: no shell, no \`Task\`, no files on disk. Everything the skill
above tells you to read is already below, and everything it tells you to write goes
through two tools.

- **\`${SAVE_APP_TOOL}\`** saves this app's whole document. The app is
  \`${appId}\`; you never name a path. Every save that parses repaints the person's
  screen, so save as you go — a save is cheap and silence is not. There is no
  edit-in-place tool: save the full document each time.
- **\`validate\`** is the floor. Call it on what you saved, fix what it names, save
  again. You are not done until it comes back clean.
- **\`${ESCALATE_TOOL}\`** is the one door out. Assembling a document out of this
  product's components is all you can do; anything that needs real code, its own
  server, a file the person uploads, or a surface these components cannot express
  goes through it. Write the plan when you escalate — that plan becomes the first
  thing the person sees while the builder works, so it is not a formality.
- \`${SCREEN_STEPS}\` steps is the whole budget. Escalate rather than run out of it.

Never look for a tool that builds the app for you. There isn't one, and that is
deliberate.

## This product's tools, with the shapes they return

${toolBrief(listings)}`;

/** The full brief: the deployment's own prompt, the shipped job description, the
 *  shipped syntax manual, then what is different here. */
function screenBrief(input: ScreenInput, listings: readonly ToolListing[]): string {
  return [
    input.system,
    buildingAppsSkill.body,
    buildingAppsSkill.files?.[`references/${"format.md"}`],
    environmentNote(input.appId, listings),
  ]
    .filter((section): section is string => section !== undefined && section.trim().length > 0)
    .join("\n\n---\n\n");
}

/**
 * ONE assembly run, over any surface a `Turn` satisfies.
 *
 * Every host effect goes through `surface.tools.call()` and every file write
 * through `surface.workspace`, so the guard, the audit row, the approval card and
 * the paint seam are not this function's business and cannot be forgotten.
 */
export async function assembleScreen(
  surface: ScreenSurface,
  input: ScreenInput,
): Promise<ScreenResult> {
  if (surface.signal.aborted) return { kind: "unavailable", why: "the caller hung up" };

  const directory = appDirectory(input.appId);
  const listings = await surface.tools.list().catch(() => [] as ToolListing[]);

  /**
   * Write one hot-path file and land it.
   *
   * The commit IS the store write and the paint (§1.6). Whether it painted is the
   * seam's own verdict, reached inside `commit()` and reported to the seam's
   * `emit` — which belongs to whoever wrapped this workspace, not to us. So this
   * reports what it can actually know: did the commit land. `validate` is what
   * tells the model whether what landed is any good — which is this loop's review
   * floor by design, exactly as `AppsRuntime.authored` says — and the front door
   * checks the app's ROW before it promises the person a screen.
   */
  const save = async (file: string, content: string): Promise<boolean> => {
    await surface.workspace.writeFile(`${directory}/${file}`, content);
    const result = await surface.workspace.commit({ message: `${file} (${input.appId})` });
    return result.status === "ok";
  };

  let escalated: string | undefined;
  let title: string | undefined;
  /** Did an `app.vendo` save ever reach the store? */
  let assembled = false;

  const tools: ToolSet = {};
  for (const listing of listings) {
    // The small loadout: the assembly verbs by name, plus the host's read tools
    // so a query's real values can be learned when a tool declares no shape.
    // `vendo_make` is excluded by name — it is what called this loop — and a
    // mutating host tool is not an assembly tool.
    if (!ASSEMBLY_TOOLS.includes(listing.name) && listing.risk !== "read") continue;
    if (listing.name === VENDO_MAKE_TOOL) continue;
    tools[listing.name] = tool({
      description: modelToolDescription(listing),
      inputSchema: jsonSchema((listing.inputSchema ?? NO_INPUT_SCHEMA) as Parameters<typeof jsonSchema>[0]),
      execute: async (args: unknown) => surface.tools.call(listing.name, args as Json),
    });
  }

  tools[SAVE_APP_TOOL] = tool({
    description:
      "Save this app's whole document. The person's screen repaints on every save that parses, so save "
      + "as you go rather than once at the end. Returns whether the save landed.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The complete app document, in the .vendo format."),
    }),
    execute: async ({ content }) => {
      const landed = await save(APP_FILE, content);
      if (!landed) {
        return { saved: false, note: "The save did not land — someone else changed this app. Save again." };
      }
      assembled = true;
      title = nameOf(content) ?? title;
      return { saved: true, note: "Run validate on it now." };
    },
  });

  tools[ESCALATE_TOOL] = tool({
    description:
      "Hand this ask to the builder, which has real code, a real machine and no step budget. Use it when "
      + "assembling a document out of this product's components genuinely cannot serve the ask. Write the "
      + "plan: it becomes the skeleton the person watches while the builder fills it in. This ends your turn.",
    inputSchema: z.object({
      plan: z.string().min(1).describe("The plan document, in the .vendo plan format."),
      why: z.string().min(1).describe("One plain sentence: what assembly cannot do here."),
    }),
    execute: async ({ plan, why }) => {
      // §4.5: no consent step and no ceremony. The plan lands, its skeleton
      // paints in seconds, and the work proceeds — so the only thing this
      // returns is the fact that it happened.
      const landed = await save(PLAN_FILE, plan);
      escalated = why;
      return { handedOver: true, planSaved: landed };
    },
  });

  const equipped = Object.keys(tools);
  // Seats are required only where a harness reads them (contract §4, relaxed) —
  // and the screen agent thinks with `default`, so a turn without it is the
  // caller's composition bug, named loudly rather than limped past. Same posture
  // as `vendo()`, which reads the same seat.
  const model = surface.models.default;
  if (model === undefined) {
    throw new Error("the screen agent thinks with `turn.models.default`, and this turn carries no default seat");
  }
  let loop: Awaited<ReturnType<typeof startTurn>>;
  try {
    loop = await startTurn({
      model,
      system: screenBrief(input, listings),
      messages: [{ id: `screen_${input.appId}`, role: "user", parts: [{ type: "text", text: input.request }] }],
      tools,
      signal: surface.signal,
      // The shipped loadout rail. `attach` is a no-op for `instant()`'s reason:
      // `find_tools` is the RUNTIME's, and a screen agent has a fixed loadout —
      // there is nothing for it to discover mid-run.
      toolSearch: { activeToolNames: () => equipped, attach: () => {} },
      context: { maxSteps: SCREEN_STEPS },
    });
  } catch (error) {
    return { kind: "unavailable", why: wireErrorMessage(error) };
  }

  try {
    // The stream MUST be drained or nothing runs. Nothing is teed and nothing is
    // buffered: this loop produces no prose for a person — the screen is the
    // answer and the front door speaks the receipt.
    for await (const part of loop.result.fullStream) {
      if (part.type === "abort") return { kind: "unavailable", why: "the caller hung up" };
      if (part.type === "error") {
        // A model failure after a screen already painted is not a failed screen.
        if (!assembled && escalated === undefined) {
          return { kind: "unavailable", why: wireErrorMessage(part.error) };
        }
      }
    }
  } catch (error) {
    if (!assembled && escalated === undefined) return { kind: "unavailable", why: wireErrorMessage(error) };
  }

  // Escalation wins over a partial paint: the builder is finishing this app, and
  // saying "ready" over a half-assembled document would be the lie §4.5 exists
  // to avoid. `status: "building"` is the honest receipt, and the front door
  // stamps it.
  if (escalated !== undefined) return { kind: "escalate", why: escalated };
  if (assembled) return { kind: "assembled", ...(title === undefined ? {} : { title }) };
  return { kind: "unavailable", why: "assembly produced nothing that renders" };
}

// ─── Door 1: the harness ─────────────────────────────────────────────────────

/**
 * The screen agent as a `Harness`.
 *
 * Its `Turn` is the surface, verbatim: the runtime already wrapped
 * `turn.workspace` with the render seam, already bound `turn.tools` to the guard,
 * and already assembled `turn.system`. So this door is the lean loop with nothing
 * around it — which is the point of `ScreenSurface` being a structural subset of
 * `Turn`.
 */
export function screenAgent(): Harness<never> {
  return defineHarness<never>({
    name: "screen",
    // Uncurated for `claudeCode()`'s reason: this loadout is chosen here, by
    // name and by risk, so the discovery loadout has nothing to add — and
    // `vendo_make` is withheld because the screen agent is what it calls.
    toolSurface: { curated: false, withhold: [VENDO_MAKE_TOOL] },
    async *run(turn: Turn<never>) {
      if (turn.signal.aborted) return;
      const appId = `app_${globalThis.crypto.randomUUID()}` as AppId;
      yield { type: "status", label: "Putting it together…", phase: "assembling", appId };
      const result = await assembleScreen(turn, {
        appId,
        request: latestAsk(turn),
        ...(turn.system === undefined ? {} : { system: turn.system }),
      });
      // One line, consumer voice — the screen IS the answer, so this is never a
      // narration of it (§10.1).
      yield { type: "text", delta: sayFor(result) };
    },
  });
}

/** The person's latest words — what a screen is assembled from. */
const latestAsk = (turn: Turn<unknown>): string => {
  for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
    const message = turn.messages[index];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
};

const sayFor = (result: ScreenResult): string => {
  if (result.kind === "assembled") return `${result.title ?? "It"} is on your screen.`;
  if (result.kind === "escalate") return "That one needs building — I've started it, and the outline is on your screen.";
  return "I couldn't put that together. Try describing it a different way.";
};

// ─── Door 2: the `vendo_make` route ──────────────────────────────────────────

export interface ScreenAssemblerDeps {
  /** The seats, as `Turn.models` carries them. */
  models: SeatModels<LanguageModel>;
  /** The GUARD-BOUND registry (`VendoGuard.bind(hostTools)`) — the same choke
   *  point every harness's calls pass through. */
  tools: ToolRegistry;
  /** This principal's workspace, unwrapped. The assembler wraps it with the
   *  render seam itself, so composition never has to know that it must. */
  workspace: (ctx: RunContext) => Promise<WorkspaceFs>;
  /** The seam's optional halves — plan facts and the app half (`AppsRuntime.authored`). */
  render?: (ctx: RunContext) => Omit<RenderSeamOptions, "emit">;
  /** The deployment's assembled prompt for this ctx, when composition has one. */
  system?: (ctx: RunContext) => Promise<string | undefined>;
}

/**
 * The `ScreenAssembler` the front door routes into.
 *
 * The layering is why this door exists at all. `@vendoai/apps` depends on `core`
 * alone, so the `vendo_make` handler cannot reach a harness; and a harness cannot
 * reach the conductor either (`instant.ts:19-24` — that would be a second,
 * unguarded door into generation and a pipeline body in the wrong package). So
 * the two meet on core's `ScreenAssembler` and composition — the one place that
 * already holds the store, the guard-bound registry, the seats and the seam — is
 * what fills the slot. Unfilled, `vendo_make` behaves exactly as it did.
 *
 * The tool surface here is projected off the registry rather than off a `Turn`,
 * for the same reason the conductor's `queryRunner` is: this call is INSIDE a
 * tool the resident already mirrored and audited, so re-mirroring the assembly
 * loop's own reads would double every call in the transcript. The guard is the
 * same guard either way — that is the part that cannot be skipped.
 */
export function screenAssembler(deps: ScreenAssemblerDeps): ScreenAssembler {
  return {
    async assemble(request: ScreenRequest, ctx: RunContext): Promise<ScreenOutcome> {
      const base = await deps.workspace(ctx);
      const workspace = wrapWorkspaceForRender(base, {
        ...deps.render?.(ctx),
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
        emit: (_streamId, part) => request.onView?.(part),
      });
      const system = await deps.system?.(ctx);
      const result = await assembleScreen(
        {
          models: deps.models,
          tools: registryTools(deps.tools, ctx),
          workspace,
          // The front door owns cancellation: `vendo_make` resolves or it does
          // not, and the tool bridge is what a caller aborts.
          signal: new AbortController().signal,
        },
        {
          appId: request.appId,
          request: request.request,
          ...(system === undefined ? {} : { system }),
        },
      );
      return result.kind === "assembled" ? { kind: "assembled" } : result;
    },
  };
}

/**
 * `TurnTools` over the guard-bound registry.
 *
 * Three statuses out of seven, exactly as the harness contract's `ToolResult`
 * defines them (§1.1): `blocked` and `connect-required` are the guard saying no,
 * and a parked approval is not something an assembly loop can wait for — so it
 * reads as denied with the reason, which is what the model needs in order to
 * write around it rather than bind a value it never got.
 */
function registryTools(registry: ToolRegistry, ctx: RunContext): TurnTools {
  return {
    async list(): Promise<ToolListing[]> {
      const descriptors = await registry.descriptors(ctx).catch(() => []);
      return descriptors.map((descriptor) => ({
        name: descriptor.name,
        title: descriptor.title ?? descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
        ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
      }));
    },
    async call(name, args) {
      const outcome = await registry.execute(
        { id: `call_${globalThis.crypto.randomUUID()}`, tool: name, args },
        ctx,
      );
      if (outcome.status === "ok") return { status: "ok", output: outcome.output };
      if (outcome.status === "error") return { status: "error", error: outcome.error };
      if (outcome.status === "blocked") return { status: "denied", reason: outcome.reason };
      if (outcome.status === "connect-required") {
        return {
          status: "denied",
          reason: `${outcome.connect.toolkit} is not connected, so this cannot be read.`,
          needs: { kind: "connect", toolkit: outcome.connect.toolkit },
        };
      }
      return {
        status: "denied",
        reason: "This one needs the person's approval, which cannot be asked for here.",
        needs: { kind: "approval", approvalId: outcome.approvalId },
      };
    },
  };
}
