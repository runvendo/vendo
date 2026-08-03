/**
 * The four shipped discovery rails, brought to the harness path.
 *
 * `createAgent` carries `find_tools`, the connection-scoped loadout, the host's
 * curated surface menu and capability-miss detection. Until now the harness path
 * carried none of them, which is why `POST /threads` only routes to a harness a
 * host explicitly named — flipping the default would have silently dropped all
 * four. This file is what closes that gap, and it closes it by REUSING the
 * shipped sessions rather than re-deriving them: `createToolSearchSession` and
 * `createCapabilityMissDetector` are the same code `createAgent` drives, so a
 * rail can only drift by being changed for both callers at once.
 *
 * The dividing line decides the split. The harness decides what to OFFER its
 * model; the registry, the guard and the CURATION are ours. So the loadout lives
 * here, behind `turn.tools.list()` — build contract §1.1's own words for it are
 * "currently-equipped tools (post-curation)" — and a harness gets discovery by
 * re-reading that listing each step, never by learning a second API.
 *
 * Both shipped rails are authored as ai-SDK `dynamicTool`s that attach into a
 * `ToolSet`. A harness turn has no ai-SDK toolset to be the model's surface —
 * `turn.tools` is — so they are attached into one HERE and read back as callable
 * meta-tools. Same descriptions, same execute, same outcomes.
 */
import type { Json, RunContext, ThreadId, ToolDescriptor, ToolListing, ToolOutcome } from "@vendoai/core";
import {
  CAPABILITY_MISS_TOOL_NAME,
  createCapabilityMissDetector,
  createToolSearchSession,
  FIND_TOOLS_TOOL_NAME,
  type CapabilityMissConfig,
  type ToolBridgeOptions,
  type ToolSearchConfig,
} from "@vendoai/agent/internal";
import type { ToolSet } from "ai";

/** One runtime-owned meta-tool: what the harness shows its model, and the shipped
 *  session's own execute. Nothing here reaches the world — searching and
 *  reporting a miss cost no authority — so these do not pass the guard, exactly
 *  as on the shipped path. Every tool they lead the model TO is guard-bound. */
export interface MetaTool {
  listing: ToolListing;
  execute(args: Json): Promise<ToolOutcome>;
}

export interface DiscoveryRails {
  /** The equipped names, re-read on every `turn.tools.list()`. `undefined` from
   *  the builder means "no loadout rail wired", and `list()` then offers
   *  everything the ctx projects, as it did before. */
  activeToolNames?(): string[];
  /** Callable through `turn.tools.call(name, …)` and listed by `list()`. */
  meta: ReadonlyMap<string, MetaTool>;
  /** The capability-miss hook the shipped tool bridge takes. Composition merges
   *  it into the bridge options so a repeated tool failure reports itself. */
  onCall?: NonNullable<ToolBridgeOptions["onCall"]>;
}

export interface DiscoveryOptions {
  /** Every tool projected for THIS ctx — THE LAW's unattended filter has already
   *  run, so search can never resolve its way back to a withheld tool. */
  descriptors: readonly ToolDescriptor[];
  ctx: RunContext;
  /** The per-THREAD searched-in set. It outlives the turn (a discovered tool
   *  stays callable in the conversation), exactly as `createAgent`'s does. */
  loaded: Set<string>;
  toolSearch?: ToolSearchConfig;
  /** Resolved beside each other per turn, like the shipped path: the
   *  connection-scoped seed and the host's curated surface menu. A failed lookup
   *  degrades, never fails the turn — the caller resolves them. */
  seedNames?: readonly string[];
  menuNames?: readonly string[];
  /** Full descriptors for names search returned that were lazily expanded during
   *  the search itself. */
  resolve?: (names: string[]) => Promise<ToolDescriptor[]>;
  capabilityMiss?: {
    config: CapabilityMissConfig;
    /** The user's latest ask, scrubbed — `latestUserIntent(turn.messages)`. */
    intent: string;
    threadId?: ThreadId;
  };
}

/** A meta-tool's listing. Both rails are reads: searching and reporting a miss
 *  spend no authority, so §12's "reads are silent, always" covers them. */
function listingOf(name: string, title: string, tool: unknown): MetaTool["listing"] {
  const authored = tool as { description?: string; inputSchema?: { jsonSchema?: unknown } };
  return {
    name,
    title,
    description: authored.description ?? "",
    risk: "read",
    // The shipped rails declare their input with ai's `jsonSchema(...)`, which
    // keeps the raw JSON Schema on `.jsonSchema`. Reading it back is what lets an
    // in-process harness hand its model real argument schemas for these two
    // without the schema being authored a second time here.
    ...(authored.inputSchema?.jsonSchema === undefined
      ? {}
      : { inputSchema: authored.inputSchema.jsonSchema as ToolListing["inputSchema"] }),
  };
}

function metaFrom(tools: ToolSet, name: string, title: string): MetaTool | undefined {
  const tool = tools[name];
  if (tool === undefined) return undefined;
  const execute = (tool as { execute?: (input: unknown, options: unknown) => Promise<ToolOutcome> }).execute;
  if (execute === undefined) return undefined;
  return {
    listing: listingOf(name, title, tool),
    // `toolCallId`/`messages` are the ai-SDK's call options. Neither rail reads
    // them, but the signature is the SDK's, so they are supplied honestly.
    execute: (args) => execute(args, { toolCallId: `meta_${name}`, messages: [] }),
  };
}

/**
 * Build this turn's discovery rails. Every rail is independent: a deployment with
 * no `toolSearch` config still gets capability-miss reporting, and one with no
 * `capabilityMiss` config still gets `find_tools` and the loadout.
 */
export function createDiscoveryRails(options: DiscoveryOptions): DiscoveryRails {
  // ONE ToolSet, attached in the shipped ORDER: the miss detector first, so its
  // `toolsConsidered` filter sees the host tools, then tool search, whose
  // always-active sweep sees the miss reporter. `createAgent` attaches them in
  // exactly this order for exactly these reasons.
  const attached: ToolSet = Object.fromEntries(
    options.descriptors.map((descriptor) => [descriptor.name, {} as never]),
  );
  const meta = new Map<string, MetaTool>();

  const detector = options.capabilityMiss === undefined
    ? undefined
    : createCapabilityMissDetector({
        config: options.capabilityMiss.config,
        ctx: options.ctx,
        intent: options.capabilityMiss.intent,
        ...(options.capabilityMiss.threadId === undefined
          ? {}
          : { threadId: options.capabilityMiss.threadId }),
      });
  if (detector !== undefined) {
    detector.attach(attached);
    const tool = metaFrom(attached, CAPABILITY_MISS_TOOL_NAME, "Report that this cannot be done");
    if (tool !== undefined) meta.set(CAPABILITY_MISS_TOOL_NAME, tool);
  }

  const session = options.toolSearch === undefined
    ? undefined
    : createToolSearchSession({
        config: options.toolSearch,
        ctx: options.ctx,
        descriptors: options.descriptors,
        loaded: options.loaded,
        ...(options.seedNames === undefined ? {} : { seedNames: options.seedNames }),
        ...(options.menuNames === undefined ? {} : { menuNames: options.menuNames }),
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
        // Nothing to materialize INTO: the equipped set is derived from the
        // registry on every `list()`, and the registry appends a lazily expanded
        // toolkit's tools to itself during the search. The session still needs a
        // materializer present to attempt the expansion at all, and it adds the
        // resolved name to its own `available` set either way — which is what
        // makes the tool callable this turn.
        materialize: () => {},
      });
  if (session !== undefined) {
    session.attach(attached);
    const tool = metaFrom(attached, FIND_TOOLS_TOOL_NAME, "Look for a tool");
    if (tool !== undefined) meta.set(FIND_TOOLS_TOOL_NAME, tool);
  }

  return {
    meta,
    ...(session === undefined ? {} : { activeToolNames: () => session.activeToolNames() }),
    ...(detector === undefined ? {} : { onCall: detector.onCall }),
  };
}
