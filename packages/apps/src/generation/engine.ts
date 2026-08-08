/**
 * The generation engine's shared plumbing: the model-call helpers the remaining
 * actors use (the automation planner, the AI reviewer) and the
 * {@link GenerationDependencies} every generation module speaks.
 *
 * There is no create/edit loop here, and no longer one anywhere in this package.
 * The ORDER of a build is the screen assembler's own loop
 * (`harnesses/screen-agent.ts`) and, when it escalates, the server lane in
 * ./lanes.ts. What is ENFORCED lives in ./validation and ../checking.
 */
import {
  type AppDocument,
  otelTelemetry,
  type ToolSemantics,
  type Tree,
  type TreeNode,
  type VendoTheme,
} from "@vendoai/core";
import type { LanguageModel, ModelMessage } from "ai";
import type { FloorDependencies } from "../checking/deps.js";
import { modelCallParams } from "../model-params.js";
import { hasDefaultExport, pinComponentName, pinForkSource, type PinBaseline } from "../pins.js";

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
  theme?: VendoTheme;
  /** Host design rules for the generation prompt. The function form is resolved
   *  ONCE per generation (see {@link snapshotDesignRules}), so the prompts
   *  within one create never mix rule sets. */
  designRules?: string | (() => string | undefined);
  pinBaselines?: readonly PinBaseline[];
  /** Per-tool field semantics from `.vendo/semantics.json`: annotated shape
   *  cards and Kit format defaults. Keyed by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
  /**
   * The island smoke-render gate: every generated island renders once in a
   * headless DOM before it ships, so a crashing island never reaches a screen.
   * ON unless explicitly `false` — the seam the island tests run without.
   */
  pipeline?: {
    smokeRender?: boolean;
  };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** A provider-form `designRules` is resolved ONCE per generation, so every
 *  prompt within one create/edit sees the same rules; the next generation
 *  re-resolves. */
export const snapshotDesignRules = (deps: GenerationDependencies): GenerationDependencies =>
  typeof deps.designRules === "function" ? { ...deps, designRules: deps.designRules() } : deps;

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
      // Opt-in OTel GenAI spans (VENDO_OTEL_TRACING=1). App generation is the
      // most expensive lane in a turn and the one a host most needs to see.
      ...otelTelemetry("vendo.apps.generate"),
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

/**
 * Page-open prewarm. Pays the provider import + TLS/keep-alive connection cost
 * up front with a throwaway 1-token generation, so the first real create reuses
 * a live socket instead of opening one cold. Best-effort: any failure (no key,
 * offline) is swallowed.
 */
export const prewarmModels = async (models: readonly LanguageModel[]): Promise<void> => {
  const { generateText } = await import("ai");
  await Promise.all(
    models.map((model) => generateText({ model, prompt: "ok", maxOutputTokens: 1, maxRetries: 0 }).then(() => undefined).catch(() => undefined)),
  );
};

const insertChild = (parent: TreeNode, nodeId: string, index: unknown): void => {
  const children = parent.children ?? [];
  const position = typeof index === "number" && Number.isInteger(index)
    ? Math.max(0, Math.min(index, children.length))
    : children.length;
  children.splice(position, 0, nodeId);
  parent.children = children;
};

/** The deterministic fork core (06-apps §8): copies the TRUSTED captured
 *  baseline into the named generated component, mints and attaches the node, and
 *  records the pin — no model involvement, source is never retyped. The
 *  runtime's pins.fork surface (the user's Remix gesture) is the only caller. */
export const applyPinFork = (
  app: AppDocument,
  props: Record<string, unknown>,
  pinBaselines: readonly PinBaseline[] | undefined,
): string[] => {
  const fail = (message: string): string[] => [`pin fork failed: ${message}`];
  if (app.tree === undefined) return fail("this app has no tree to fork a pin into");
  const slot = props.slot;
  if (typeof slot !== "string" || slot.length === 0) return fail("requires a non-empty slot attribute");
  const baseline = pinBaselines?.find((candidate) => candidate.slot === slot);
  if (baseline === undefined) return fail(`pin baseline "${slot}" is unavailable`);
  if (app.pins?.some((pin) => pin.slot === baseline.slot)) return fail(`pin slot "${baseline.slot}" is already forked`);
  // A named-export capture forks with a synthesized default export.
  const forkSource = pinForkSource(baseline.source);
  if (!hasDefaultExport(forkSource)) {
    return fail(`pin baseline "${slot}" has no default export and no detectable named component export; export the component from its module and re-run vendo sync`);
  }
  const componentName = pinComponentName(baseline.slot);
  if (app.components?.[componentName] !== undefined) return fail(`generated component "${componentName}" already exists`);
  const tree = asTree(app.tree);
  const parentId = props.into === undefined ? tree.root : props.into;
  if (typeof parentId !== "string") return fail("into must be a string node id when present");
  const parent = tree.nodes.find(({ id }) => id === parentId);
  if (parent === undefined) return fail(`parent "${parentId}" does not exist`);
  if (props.at !== undefined && (typeof props.at !== "number" || !Number.isInteger(props.at) || props.at < 0)) {
    return fail("at must be a non-negative integer when present");
  }
  // Compiler-owned id discipline: mint past the existing ordinals.
  const key = componentName.toLowerCase();
  let ordinal = 0;
  for (const { id } of tree.nodes) {
    const match = /^([a-z][a-z0-9]*)-([1-9]\d*)$/.exec(id);
    if (match !== null && match[1] === key) ordinal = Math.max(ordinal, Number(match[2]));
  }
  const node: TreeNode = {
    id: `${key}-${ordinal + 1}`,
    component: componentName,
    source: "generated",
    ...(isRecord(props.props) ? { props: structuredClone(props.props) as TreeNode["props"] } : {}),
  };
  tree.nodes.push(node);
  insertChild(parent, node.id, props.at);
  app.components = { ...(app.components ?? {}), [componentName]: forkSource };
  app.pins = [...(app.pins ?? []), { slot: baseline.slot, base: baseline.hash }];
  return [];
};
