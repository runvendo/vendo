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
  type ShapeType,
  type ToolSemantics,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import type { LanguageModel, SystemModelMessage } from "ai";
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
  /** Each tool's declared response schema in structural form
   *  (`shapeFromJsonSchema`), keyed by tool: the shape cards the prompts render
   *  and the automation planner reads. It sits here rather than on the floor
   *  because no check reads it — the screen type check works off the tools'
   *  own `outputSchema`. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** Per-tool field semantics from `.vendo/semantics.json`: annotated shape
   *  cards and Kit format defaults. Keyed by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
}

export type GeneratedAppDocument = Omit<AppDocument, "id">;

// Anthropic prompt-caching breakpoint (mirrors packages/agent/src/agent.ts's
// CACHE_BREAKPOINT). providerOptions.anthropic is ignored by every other
// provider and by the test mocks, so marking the breakpoint degrades to a
// no-op off-Anthropic.
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** The generation prompt's stable prefix (role, dialect, component menu, host
 *  tools, design rules), marked cacheable. It is identical across back-to-back
 *  generations for a deployment, so Anthropic re-reads it from cache instead of
 *  re-billing it; the per-request `prompt` is the variable tail, deliberately
 *  left OUT of the cached prefix.
 *
 *  It travels as `system` rather than as a system-role message inside
 *  `messages`: ai@7 rejects the latter (AI_InvalidPromptError), and both majors
 *  carry this message form — breakpoint and all — to the provider unchanged. */
export const cacheableGenerationSystem = (system: string): SystemModelMessage =>
  ({ role: "system", content: system, providerOptions: CACHE_BREAKPOINT });

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
      system: cacheableGenerationSystem(system),
      prompt,
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
