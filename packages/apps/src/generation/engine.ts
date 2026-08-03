/**
 * The generation engine's shared plumbing: the model-call helpers every actor
 * uses (the brain, the fill workers, the island lane, the reviewer) and the
 * {@link GenerationDependencies} every generation module speaks.
 *
 * There is no create/edit loop here any more. The ORDER of a generation lives in
 * ./conductor.ts — one brain turn, a deterministic skeleton, parallel fill
 * workers, the checking layer — and the runtime wraps that with the store, the
 * screen, and the sandbox. What the model is TOLD lives in ./prompts and
 * ./contracts; what is ENFORCED lives in ./validation and ../checking.
 */
import {
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
  type ToolSemantics,
  type Tree,
  type TreeNode,
  type VendoTheme,
} from "@vendoai/core";
import type { LanguageModel, ModelMessage } from "ai";
import { modelCallParams } from "../model-params.js";
import { hasDefaultExport, pinComponentName, pinForkSource, type PinBaseline } from "../pins.js";

/** The slice of a tool descriptor generation needs: prompt context and the
 *  query-tool existence check. */
export interface HostToolInfo {
  name: string;
  description: string;
  risk: string;
  inputSchema?: Record<string, unknown>;
}

/** A tree on its way to the screen: the skeleton the moment a plan lands, then
 *  the same tree again with each group's contents spliced in. */
export interface GeneratedPartial {
  name?: string;
  tree: Tree;
  components?: Record<string, string>;
}

export interface GenerationDependencies {
  model: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme;
  /** Host design rules for the generation prompt. The function form is resolved
   *  ONCE per generation (see {@link snapshotDesignRules}), so the prompts
   *  within one create never mix rule sets. */
  designRules?: string | (() => string | undefined);
  pinBaselines?: readonly PinBaseline[];
  /** Shape-card outputs keyed by tool; when present, compiles type-check
   *  bindings and the fact checks surface shape mismatches. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools a query may name. Without the list the model invents tool
   *  names; with it, a query naming anything else is a fact finding. */
  tools?: readonly HostToolInfo[];
  /** Per-tool field semantics from `.vendo/semantics.json`: annotated shape
   *  cards and Kit format defaults. Keyed by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
  /** 06-apps §5 — additive, optional partial-tree streaming seam. */
  onPartial?: (partial: GeneratedPartial) => void | Promise<void>;
  /**
   * The fast fill tier. `model` is the no-think switch — point it at a
   * thinking-disabled model instance and the group workers run on it while the
   * brain keeps the main (thinking) model. Absent → workers share `model`.
   */
  fill?: {
    model?: LanguageModel;
  };
  /**
   * What this host CANNOT do, stated to the brain as FACT before it plans
   * (runtime `laneGates`). A lane the host does not have becomes a `<Cannot>`
   * line the person reads in seconds, instead of a build that runs, escalates,
   * and only then discovers a flag is off.
   */
  hostCannot?: readonly string[];
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
 * A placeholder id for a document that is being generated and has not been
 * stored yet. Nothing keys off it — it exists because `AppDocument` carries an
 * id, the checks floor takes a whole `AppDocument` (build contract §5), and a
 * freshly generated app has no id until the runtime mints one. Named once here
 * so the mid-fill checks and the finished-app checks use the same one.
 */
export const UNSTORED_APP_ID = "app_conducted";

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
