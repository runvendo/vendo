import {
  VENDO_APPROVAL_REF_KIND,
  VENDO_APP_REF_KIND,
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  canonicalJson,
  makeReceiptSchema,
  type AgentRunner,
  type Json,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoAppRef,
  type VendoApprovalRef,
  type VendoToolEnvelope,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import {
  VENDO_DELEGATE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
} from "./tool-pack.js";

/**
 * Existing-agents seam — the framework-neutral tool pack a BYO agent loop gets
 * (frozen contract: docs/superpowers/specs/2026-07-20-existing-agents-contracts.md §2).
 * A promotion of the guard-bound wrapping Vendo's own loop uses (tools.ts):
 * every pack tool executes through the SAME guard-bound registry, so no tool
 * reachable from a BYO loop has an unguarded route. The umbrella's `./ai-sdk`
 * and `./mastra` subpaths are thin format shims over this core.
 */

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const TITLE_CAP = 80;
const SUMMARY_CAP = 500;

export interface VendoToolPackCoreOptions extends VendoToolPackFilter {
  /** The guard-bound registry (guard.bind(actions)) — the pack never wraps an
   *  unbound registry; parking, grants, breakers, and audit all live in the
   *  binding's execute path. */
  registry: ToolRegistry;
  /** Backs `vendo_delegate` (the umbrella passes `agent.asRunner()`). */
  runner: AgentRunner;
}

/** How a pack tool is executed by a format shim. `ctx` is per-call because the
 *  Mastra shim resolves its principal lazily from the framework's request
 *  context; the AI SDK shim closes one request-scoped ctx over every call. */
export interface VendoPackExecuteOptions {
  ctx: RunContext;
  /** The host loop's tool-call id, for audit continuity; unset mints one. */
  callId?: string;
}

/** One framework-neutral pack tool: final `vendo_*` name, the descriptor's
 *  JSON-Schema input, and a guarded execute returning either a versioned
 *  envelope (`vendo/app-ref@1`, `vendo/approval-ref@1`) or plain data. */
export interface VendoPackTool {
  name: string;
  description: string;
  inputSchema: Json;
  execute(input: unknown, options: VendoPackExecuteOptions): Promise<unknown>;
}

function mintCallId(): string {
  return `call_${globalThis.crypto.randomUUID()}`;
}

function executionError(): ToolOutcome {
  return {
    status: "error",
    error: { code: "execution", message: "Tool execution failed." },
  };
}

/** One human-readable line describing what is waiting — the tool descriptor
 *  plus the guard's inputPreview vocabulary (`<tool> <canonical args>`). */
function approvalSummary(descriptor: ToolDescriptor, args: unknown): string {
  let preview: string;
  try {
    preview = canonicalJson(args);
  } catch {
    preview = "";
  }
  const summary = `Awaiting user approval: ${descriptor.description || descriptor.name} — ${descriptor.name} ${preview}`
    .replace(/\s+/g, " ")
    .trim();
  return summary.length > SUMMARY_CAP ? `${summary.slice(0, SUMMARY_CAP - 1)}…` : summary;
}

function approvalRef(approvalId: string, descriptor: ToolDescriptor, args: unknown): VendoApprovalRef {
  return { kind: VENDO_APPROVAL_REF_KIND, approvalId, summary: approvalSummary(descriptor, args) };
}

/** The embed-chrome title known at fast-return time: the prompt itself,
 *  collapsed to one line and capped. */
function titleFromPrompt(prompt: unknown): string {
  const collapsed = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
  if (collapsed.length === 0) return "Vendo app";
  return collapsed.length > TITLE_CAP ? `${collapsed.slice(0, TITLE_CAP - 1)}…` : collapsed;
}

/**
 * A `MakeReceipt` carries its own honest status (`"ready" | "building" |
 * "failed"`, `packages/core/src/make-receipt.ts`) and a speakable `say` line
 * — exactly the two fields a failed edit needs to be reported as failed. A
 * failed receipt must NEVER become a ref: the ref schema has no room for
 * failure (runvendo/flowlet#822 defect 2, generalized) — an id and a title
 * are the whole shape of "this exists and is fine". Returning null here lets
 * the caller fall back to the receipt itself, `status` and `say` intact.
 */
function appRefFromReceipt(output: unknown, fallbackTitle: string): VendoAppRef | null {
  const receipt = makeReceiptSchema.safeParse(output);
  if (!receipt.success || receipt.data.status === "failed") return null;
  return {
    kind: VENDO_APP_REF_KIND,
    appId: receipt.data.id,
    title: receipt.data.title || fallbackTitle,
    status: "building",
  };
}

async function guardedExecute(
  registry: ToolRegistry,
  call: VendoViewStreamingToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> {
  try {
    return await registry.execute(call, ctx);
  } catch {
    return executionError();
  }
}

/** Envelope-or-plain-data mapping shared by every pack tool: parking returns
 *  the approval ref (no throw, no block — §2); a clean run returns the output
 *  the way any tool output reads; error/blocked outcomes pass through as plain
 *  data the model can act on. */
function mapOutcome(outcome: ToolOutcome, descriptor: ToolDescriptor, args: unknown): unknown {
  if (outcome.status === "pending-approval") return approvalRef(outcome.approvalId, descriptor, args);
  if (outcome.status === "ok") return outcome.output;
  return outcome;
}

function applyFilter(names: string[], filter: VendoToolPackFilter): Set<string> {
  const included = filter.include === undefined
    ? new Set(names)
    : new Set(names.filter((name) => filter.include!.includes(name)));
  for (const name of filter.exclude ?? []) included.delete(name);
  return included;
}

function wrapHostTool(registry: ToolRegistry, descriptor: ToolDescriptor): VendoPackTool {
  return {
    name: `${VENDO_TOOL_PACK_PREFIX}${descriptor.name}`,
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.inputSchema) as Json,
    async execute(input, options) {
      const call = { id: options.callId ?? mintCallId(), tool: descriptor.name, args: input };
      const outcome = await guardedExecute(registry, call, options.ctx);
      return mapOutcome(outcome, descriptor, input);
    },
  };
}

/** `vendo_make` — the pack's app door is Vendo's own make tool, returning fast:
 *  the FIRST streamed view part already carries the app's permanent id, so the
 *  app-ref envelope goes back to the loop while the build keeps streaming over
 *  the wire. Without a streamed part the finished document supplies the ref. */
function makeAppTool(registry: ToolRegistry, descriptor: ToolDescriptor): VendoPackTool {
  return {
    name: VENDO_MAKE_TOOL,
    description: "Create a Vendo app (generated UI) from a plain-language request. Returns fast with a vendo/app-ref@1 envelope carrying status \"building\" — the build was only ACCEPTED and is still streaming; you have not seen its contents and do not know yet whether it will succeed. Say only that you're building it (present tense, no specifics) and stop there. Never say it is created/ready/done, and never describe, list, or invent anything it will contain (no tables, no numbers, no chart data) — the embed shows real build progress and the true final result, including a build failure, and it will contradict anything you claim. If the build later fails, you will not be told in this reply; do not assume or claim success in a later turn either — check with the user or a read tool before describing this app again.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
        app: { type: "string", minLength: 1 },
      },
      required: ["request"],
      additionalProperties: false,
    },
    async execute(input, options) {
      const fallbackTitle = titleFromPrompt((input as { request?: unknown })?.request);
      const call: VendoViewStreamingToolCall = {
        id: options.callId ?? mintCallId(),
        tool: VENDO_MAKE_TOOL,
        // Same tool, same arguments: what the model sent goes through untouched.
        args: input as Json,
      };
      let resolveFast!: (ref: VendoAppRef) => void;
      const fast = new Promise<VendoAppRef>((resolve) => { resolveFast = resolve; });
      Object.defineProperty(call, VENDO_VIEW_STREAM, {
        value: (update: { id: string; part: { appId?: unknown } }) => {
          const appId = update?.part?.appId;
          if (typeof appId === "string" && appId.startsWith("app_")) {
            resolveFast({ kind: VENDO_APP_REF_KIND, appId, title: fallbackTitle, status: "building" });
          }
        },
      });
      const settled = guardedExecute(registry, call, options.ctx).then((outcome) => {
        if (outcome.status === "ok") {
          return appRefFromReceipt(outcome.output, fallbackTitle) ?? outcome.output;
        }
        return mapOutcome(outcome, descriptor, input);
      });
      // The build may still be streaming when the fast ref wins the race; its
      // completion (and any late failure) belongs to the wire, not this call.
      settled.catch(() => undefined);
      return Promise.race([fast, settled]);
    },
  };
}

/** `vendo_delegate` — whole-task delegation through the same AgentRunner seam
 *  automations ride. The delegated run executes over THIS registry (guard-bound),
 *  and everything envelope-worthy it produces comes back as refs. */
function delegateTool(registry: ToolRegistry, runner: AgentRunner): VendoPackTool {
  return {
    name: VENDO_DELEGATE_TOOL,
    description: "Delegate a whole task to Vendo's own agent. Runs to completion server-side and returns { status, summary, refs } — refs carry vendo/app-ref@1 / vendo/approval-ref@1 envelopes for anything the run produced.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: { task: { type: "string", minLength: 1 } },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, options) {
      const task = (input as { task?: unknown })?.task;
      const refs: VendoToolEnvelope[] = [];
      const descriptorsByName = registry.descriptors().then(
        (descriptors) => new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
      );
      descriptorsByName.catch(() => undefined);
      const capturing: ToolRegistry = {
        // Forward the projection context: the delegated run gets the toolset THE
        // LAW allows it (design §12), not the full one. A decorator that
        // re-declares `descriptors()` with no parameter swallows the ctx, and
        // `guard.bind` answers a ctx-less call with everything — so delegating
        // from an unattended run would have handed the sub-run every destructive
        // tool the outer run was denied.
        descriptors: (ctx) => registry.descriptors(ctx),
        async execute(call, runCtx) {
          const outcome = await registry.execute(call, runCtx);
          if (call.tool === VENDO_MAKE_TOOL && outcome.status === "ok") {
            const ref = appRefFromReceipt(outcome.output, titleFromPrompt((call.args as { request?: unknown })?.request));
            if (ref !== null) refs.push(ref);
          } else if (outcome.status === "pending-approval") {
            const descriptor = (await descriptorsByName.catch(() => undefined))?.get(call.tool)
              ?? { name: call.tool, description: "", inputSchema: {}, risk: "write" as const };
            refs.push(approvalRef(outcome.approvalId, descriptor, call.args));
          }
          return outcome;
        },
      };
      try {
        const report = await runner(
          { prompt: typeof task === "string" ? task : "", tools: capturing },
          options.ctx,
        );
        const result: VendoDelegateResult = { status: report.status, summary: report.summary, refs };
        return result;
      } catch {
        const result: VendoDelegateResult = {
          status: "error",
          summary: "The delegated run could not be completed.",
          refs,
        };
        return result;
      }
    },
  };
}

/**
 * Build the pack: every registered host tool guard-wrapped under `vendo_`,
 * plus the two built-ins. Vendo-internal registry tools (names already under
 * `vendo_` — the apps runtime's `vendo_apps_*`, doctor probes) are never
 * double-wrapped: the pack's door to app creation is `vendo_make` itself, and
 * in-app interaction rides the wire, not the host loop. `include`/`exclude`
 * match FINAL namespaced names exactly; exclude wins.
 */
export async function buildVendoToolPack(options: VendoToolPackCoreOptions): Promise<VendoPackTool[]> {
  const descriptors = await options.registry.descriptors();
  const byName = new Map<string, VendoPackTool>();
  for (const descriptor of descriptors) {
    if (descriptor.name.startsWith(VENDO_TOOL_PACK_PREFIX)) continue;
    const tool = wrapHostTool(options.registry, descriptor);
    byName.set(tool.name, tool);
  }
  // Built-ins land last: a host tool whose namespaced name collides with one
  // can never shadow the pack's own doors.
  const makeTool = descriptors.find((descriptor) => descriptor.name === VENDO_MAKE_TOOL);
  if (makeTool !== undefined) {
    byName.set(VENDO_MAKE_TOOL, makeAppTool(options.registry, makeTool));
  }
  byName.set(VENDO_DELEGATE_TOOL, delegateTool(options.registry, options.runner));
  const included = applyFilter([...byName.keys()], options);
  return [...byName.values()].filter((tool) => included.has(tool.name));
}
