/**
 * The generation engine's shared plumbing: the model-call helpers the remaining
 * actors use (the automation planner, the AI reviewer) and the
 * {@link GenerationDependencies} every generation module speaks.
 *
 * There is no create/edit loop here, and no longer one anywhere in this package.
 * The ORDER of a build is the screen assembler's own loop
 * (the umbrella's `screen-agent.ts`) and, when it escalates, the server lane in
 * ./lanes.ts. What is ENFORCED lives in ./validation and ../checking.
 */
import {
  type ToolSemantics,
} from "@vendoai/core";
import {
  type AppDocument,
  type Tree,
} from "../../contract/index.js";
import type { LanguageModel, ModelMessage } from "ai";
import type { FloorDependencies } from "../checking/deps.js";
import { modelCallParams } from "../runtime/model-params.js";

/** The floor owns the tool slice now (`../checking/deps.ts`) so it can outlive
 *  this pipeline; re-exported here because every generation module already
 *  imports it from this file. */
export type { HostToolInfo } from "../checking/deps.js";

/**
 * Everything a generation needs — the floor's four fields plus the pipeline's
 * own. It EXTENDS {@link FloorDependencies} rather than restating it, so the
 * assignability the conductor's checking layer relies on is declared instead of
 * left to structural luck.
 */
export interface GenerationDependencies extends FloorDependencies {
  /** Narrowed to REQUIRED: the floor can run its deterministic half without a
   *  model, but a generation cannot happen without one. */
  model: LanguageModel;
  /** Per-tool field semantics from `.vendo/semantics.json`: annotated shape
   *  cards and Kit format defaults. Keyed by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
}

export type GeneratedAppDocument = Omit<AppDocument, "id">;

/**
 * A stored document's `tree` (the open UIPayload the store speaks) and the
 * genui `Tree` are the same structure under two names. These two casts are the
 * ONLY bridge between them — an `as unknown as` on a tree anywhere else is a
 * smell. `asTree` trusts its caller about presence, exactly as the casts it
 * replaced did: guard `undefined` before converting.
 */
export const asTree = (tree: GeneratedAppDocument["tree"]): Tree => tree as unknown as Tree;

export const asPayload = (tree: Tree): NonNullable<GeneratedAppDocument["tree"]> =>
  tree as unknown as NonNullable<GeneratedAppDocument["tree"]>;

// Anthropic prompt-caching breakpoint (mirrors packages/agent/src/agent.ts's
// CACHE_BREAKPOINT). providerOptions.anthropic is ignored by every other
// provider and by the test mocks, so marking the breakpoint degrades to a
// no-op off-Anthropic.
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** The generation prompt as a two-message model prompt with the stable prefix
 *  (role, dialect, component menu, host tools, design rules) marked cacheable.
 *  The system message is the END of the stable prefix — identical across
 *  back-to-back generations for a deployment — so Anthropic re-reads it from
 *  cache instead of re-billing it. The user message is the per-request variable
 *  tail, deliberately left OUT of the cached prefix. */
export const cacheableGenerationMessages = (system: string, prompt: string): ModelMessage[] => [
  { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
  { role: "user", content: prompt },
];

/**
 * One model call, text accumulated off the stream — the answer lands whole or
 * not at all. Every generation actor speaks through here (the brain, a fill
 * worker, the island lane, the automation planner), so the failure handling
 * exists exactly once: streamText does NOT throw provider errors (its default
 * onError logs the raw error and the text stream simply ends), so a missing
 * key or quota exhaustion is captured here or it reaches the caller as an
 * unclassifiable empty answer.
 *
 * The "model generation failed: " prefix is load-bearing, not decoration:
 * runtime.buildFailureReason strips exactly it before matching the
 * no-usable-credential lines, so a 402 classifies as non-retryable quota and
 * the actionable `npm install @ai-sdk/...` line reaches the person.
 */
export const askModel = async (
  model: LanguageModel,
  system: string,
  prompt: string,
): Promise<{ text?: string; issues: string[] }> => {
  try {
    const { streamText } = await import("ai");
    let streamError: unknown;
    const result = streamText({
      model,
      messages: cacheableGenerationMessages(system, prompt),
      ...modelCallParams(model),
      maxRetries: 0,
      onError: ({ error }) => { streamError = error; },
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    if (streamError !== undefined) {
      return { issues: [`model generation failed: ${streamError instanceof Error ? streamError.message : "unknown error"}`] };
    }
    if (text.trim().length === 0) {
      return { issues: ["the model answered with no text at all (an empty or reasoning-only response from the provider)."] };
    }
    return { text, issues: [] };
  } catch (error) {
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

export const distinctIssues = (current: string[], next: string[]): string[] => [
  ...new Set([...current, ...next]),
];
