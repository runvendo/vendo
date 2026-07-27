/**
 * The generation engine orchestrator: the create/edit loops (modelEngine),
 * wire streaming, the escalation judgments the runtime rides
 * (instructionRequiresServer / serverWorkRung / instructionRequiresServedApp),
 * and the GenerationDependencies / pipeline types every generation module
 * shares. What the model is TOLD lives in ./contracts, what is ENFORCED in
 * ./validation, and what RUNS AROUND the model in ./stages.
 */
import {
  VENDO_TREE_FORMAT,
  VendoError,
  compileWirePatch,
  compileWire,
  findDeprecatedReshapeUsage,
  printWire,
  type AppDocument,
  type DomainManifest,
  type NormalizedCatalog,
  type ShapeType,
  type ToolSemantics,
  type TreeNode,
  type Tree,
  type VendoTheme,
  type WireCompileResult,
} from "@vendoai/core";
import type { LanguageModel, ModelMessage } from "ai";
import { modelCallParams } from "../model-params.js";
import { hasDefaultExport, pinComponentName, pinForkSource, type PinBaseline } from "../pins.js";
import { createContract } from "./contracts/create.js";
import { editContract } from "./contracts/edit.js";
import { layoutHeader, tier0Contract } from "./contracts/paint.js";
import { composePromptSections, hostToolSections, islandContract } from "./contracts/sections.js";
// The production compile options, shared with the stages' own compiles
// (region-parallel assembly, repair/end-pass recompiles) so every compile of
// model wire speaks the same dialect.
import { wireCompileOptionsFor } from "./wire-options.js";
import { regionParallelCreate } from "./stages/parallel.js";
import { structuredRepair } from "./stages/repair.js";
import { dataSightedVerify, endPass, extractEdit } from "./stages/verify.js";
import { prepareIslands } from "./validation/islands.js";
import { validateCompiledCreate, validateEditedApp } from "./validation/validate.js";

/** The slice of a tool descriptor generation needs: prompt context and the
 *  query-tool existence check. `inputSchema` feeds the structured-repair
 *  payload skeleton for mutation-without-payload fixes. */
export interface HostToolInfo {
  name: string;
  description: string;
  risk: string;
  inputSchema?: Record<string, unknown>;
}

/** A compiled prefix of the streaming wire: always a validateTree-passing
 *  tree (valid-while-partial) plus the islands admitted so far. */
export interface GeneratedPartial {
  name?: string;
  tree: Tree;
  components?: Record<string, string>;
}

/** Structured create timing emitted per lane. `atMs` is milliseconds since
 *  the create() call began; `first-partial` fires when the first compiled
 *  prefix reaches the seam (time-to-paint) and `complete` when the lane's
 *  stream ends (with token usage). The full lane may repair up to 3× on
 *  validation failure, so it emits one `complete` per attempt — the LAST
 *  `full`/`complete` is the successful document; earlier ones are failed
 *  attempts. Opt-in: nothing is emitted unless `onTiming` is wired. */
export interface GenerationTimingEvent {
  lane: "paint" | "full" | "outline" | "section" | "repair" | "end-pass";
  phase: "first-partial" | "complete";
  atMs: number;
  thinking: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Engine-internal pipeline knobs. `structuredRepair` replaces free-form
 *  repair regeneration with one strict tool-use call over the closed fix
 *  space; on by default. `regionParallel` (outline + parallel section
 *  writers) and `endPass` (no-think polish read-through) are opt-in flags
 *  while being measured. */
export interface PipelineConfig {
  structuredRepair?: boolean;
  regionParallel?: boolean;
  endPass?: boolean;
  /** The exemplar-led create contract (single-voice sections, principles
   *  stated once, worked exemplars; scar-tissue rules retired to validators +
   *  repair). Opt-in while the A/B against the current contract is measured. */
  exemplarContract?: boolean;
  /** The smoke-render gate: every island renders once in a headless DOM
   *  (dedicated worker + jsdom, ambient scope stubbed) inside create
   *  validation; a crash routes to repair like any issue. On by default;
   *  `false` disables. Catches the crash classes the 2026-07-21 gate shipped
   *  (React #310 hooks-in-map, undefined names, unguarded-data throws). */
  smokeRender?: boolean;
  /** The data-sighted verify's rebind arm (re-gate 2026-07-26: wrong-data-
   *  binding is the top model-error class in every arm and the copy-only
   *  verify caught none of them). Under `endPass` + this flag, the verify may
   *  point a lying binding at the right field — but only through structured
   *  repair's closed fix space (a strict enum of real, kind-compatible field
   *  paths; at most 2 rebinds; full revalidation or the original ships).
   *  Opt-in while the A/B (verify-with-rebind vs verify-without) is measured;
   *  default OFF. */
  rebind?: boolean;
}

/** Opt-in per-stage diagnostics: rounds, no-valid-fix take-rate,
 *  region-parallel fallback reasons, end-pass adoption, wall-clock per stage.
 *  Powers live measurement and production observability. */
/**
 * The validation issues still outstanding when a stage ends without a valid
 * document. Present ONLY on the failing outcome of the stages that hold a real
 * issue list; the same strings the engine logs and the final VendoError
 * carries. Without this a failed create reads as "model could not produce a
 * valid app" everywhere the console is not attached (bench subprocess, hosted
 * runs) — the reason is exactly the signal format/guardrail work needs.
 */
export type PipelineEvent =
  // `rebinds` counts the deterministic wrapper-envelope repoints (an array
  // prop bound to the `{ data: [...] }` wrapper); those cost no strict round,
  // so a repair event can carry rounds: 0.
  | { stage: "repair"; rounds: number; repaired: boolean; noValidFix: number; rebinds?: number; ms: number; issues?: readonly string[] }
  | { stage: "region-parallel"; fallback?: "no-outline" | "sections-failed" | "assembly-invalid"; sectionsPlanned?: number; sectionsLanded?: number; ms: number; issues?: readonly string[] }
  | { stage: "end-pass"; applied: boolean; ms: number }
  // data-verify: `relabels` counts ALL surviving copy-pass ops (Set/Unset/
  // Remove/SetName — the ≤4-op budget), `rebinds` the strict-enum binding
  // repoints (≤2) applied by the rebind arm (pipeline.rebind).
  | { stage: "data-verify"; applied: boolean; relabels: number; rebinds: number; ms: number }
  // demo-latency lane — island-scoped repair: when EVERY validation issue is
  // island-scoped, only the offending island sources are rewritten (one small
  // model call) instead of regenerating the whole app (a full-lane attempt).
  | { stage: "island-repair"; islands: number; repaired: boolean; ms: number; issues?: readonly string[] }
  // speed-core (criterion 1) — one event per FULL-lane attempt in the create
  // loop, so the full→island-repair ordering is provable from the pipeline
  // event stream alone. Additive; existing stages never renamed.
  | { stage: "full"; attempt: number; valid: boolean; ms: number; issues?: readonly string[] };

export interface GenerationDependencies {
  model: LanguageModel;
  /** The composition-normalized catalog (01 §14): propsJsonSchema is derived. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme;
  /** Host design rules for the generation prompt. The function form is
   *  resolved every time prompt sections are built, so a per-call source
   *  (e.g. `.vendo/design-rules.md`) is re-read on each create/edit. */
  designRules?: string | (() => string | undefined);
  pinBaselines?: readonly PinBaseline[];
  /** Shape-card outputs keyed by tool; when present, create and edit compiles
   *  type-check bindings and surface shape-mismatch repair. */
  toolShapes?: Readonly<Record<string, ShapeType>>;
  /** The host tools queries may name. When present they are listed in the
   *  generation prompt and a query naming any other tool is a validation
   *  error routed to repair (without the list the model invents tool names). */
  tools?: readonly HostToolInfo[];
  /** Per-tool field semantics from `.vendo/semantics.json`: annotate the
   *  shape cards, drive Kit format defaults, and feed the law checks. Keyed
   *  by tool name. */
  semantics?: Readonly<Record<string, ToolSemantics>>;
  /** The host's domain manifest (has / has-NOT), surfaced to generation as
   *  fact so out-of-domain asks get a Disclaimer, never invented data. */
  domains?: DomainManifest;
  /** 06-apps §5 — additive, optional partial-tree streaming seam. */
  onPartial?: (partial: GeneratedPartial) => void | Promise<void>;
  /**
   * The tier-0 paint lane. The lane runs only when a streaming consumer
   * (onPartial) is wired: the instant paint exists to reach a screen.
   * `model` is the no-think switch — point it at a thinking-disabled model
   * instance and the paint lane runs on it while the full lane keeps the main
   * model. `disabled` forces the single-lane flow.
   */
  paint?: {
    model?: LanguageModel;
    disabled?: boolean;
  };
  /** Opt-in structured timing seam (see GenerationTimingEvent). */
  onTiming?: (event: GenerationTimingEvent) => void;
  /** Pipeline knobs (structured repair / region-parallel / end pass). */
  pipeline?: PipelineConfig;
  /** Opt-in per-stage diagnostics (rounds, fallbacks, timing); nothing is
   *  emitted unless wired. */
  onPipeline?: (event: PipelineEvent) => void;
}

export interface GenerationCreateInput {
  prompt: string;
}

export interface GenerationEditInput {
  app: AppDocument;
  instruction: string;
  repairIssues?: string[];
}

export type GeneratedAppDocument = Omit<AppDocument, "id">;

/**
 * The engine emits ONLY tree documents. Server code never rides a model
 * "code edit" dialect: it is written BY the in-box coding agent
 * (box-agent.ts) during graduation, and the tree gains its `fn:` bindings
 * through this same tree-edit path afterward. The old code lane (file plans)
 * is deleted.
 */
export type GenerationEditResult =
  | { kind: "document"; document: GeneratedAppDocument }
  | { kind: "failure"; issues: string[] };

/** 06-apps §5 — replaceable generation seam used by createApps(). */
export interface GenerationEngine {
  create(input: GenerationCreateInput, deps: GenerationDependencies): Promise<GeneratedAppDocument>;
  edit(input: GenerationEditInput, deps: GenerationDependencies): Promise<GenerationEditResult>;
}

/** The engine's create validation, passed into the stages as a callback so
 *  they never import the validator directly (engine → stages stays
 *  one-directional). */
export type CreateValidator = (
  compiled: WireCompileResult,
) => Promise<{ document?: GeneratedAppDocument; issues: string[] }>;

export interface PipelineContext {
  deps: GenerationDependencies;
  hostComponents: readonly string[];
  validate: CreateValidator;
  /** Milliseconds origin of the surrounding create() for onTiming events. */
  startedAt: number;
  /** demo-latency lane — the engine's island-scoped repair (engine.ts owns
   *  the island contract text), passed as a callback like `validate` so the
   *  region-parallel path can rescue an assembly whose only failures are
   *  island-scoped instead of falling back to a full single-stream re-gen. */
  repairIslands?: (
    compiled: WireCompileResult,
    issues: string[],
  ) => Promise<{ document?: GeneratedAppDocument }>;
}

// The graduation judgment (instructionRequiresServer): UNAMBIGUOUS signals of
// the four machine reasons (scheduled/background work, third-party egress
// with secrets, heavy logic, app-owned state) — words that essentially never
// label a visible element.
const SERVER_INSTRUCTION = /\b(server|server-side|backend|database|persist|mutation|mutate|egress|schedule|scheduled|scheduling|cron|recurring)\b/i;
// Words that signal server work only OUTSIDE a visible-element label:
// "watch my invoices"/"email a daily digest" escalate, but "the digest card",
// "the watch list", "the API status card" stay on the cheap tree path.
const AMBIGUOUS_SERVER_TERM = /\b(api|http|web app|function|external|secret|digest|watch|monitor|daily|nightly|hourly|periodic)\b/gi;
const VISIBLE_ELEMENT_LABEL = /^(?:\w+\s+)?(card|button|badge|chip|header|heading|title|label|caption|text|list|table|column|row|cell|section|panel|chart|graph|icon|field|tab|menu|toolbar|sidebar|footer|banner|tile|widget)s?\b/i;
/** Asks whose UI needs exceed the tree (layer 3): a real served web app, or
 *  interaction vocabulary (drag-and-drop, rich text) the tree's component
 *  walk cannot express. These are unambiguous — they never label a visible
 *  element. */
const SERVED_APP_INSTRUCTION = /\b(full web app|served web app|custom (?:ui|client|frontend)|drag[- ]?(?:and|&|'n')[- ]?drop|wysiwyg|rich[- ]text editor|ui:? ?http)\b/i;
/** Served-app words that can also LABEL a visible element ("make the kanban
 *  board heading blue" is a tree ask); same outside-a-label rule as the
 *  ambiguous server terms. */
const AMBIGUOUS_SERVED_TERM = /\b(kanban|whiteboard|draggable)\b/gi;
/** Escalation-ladder rung c — UNAMBIGUOUS custom-code signals: real
 *  computation or bespoke logic no tool composition can express, so only a box
 *  (in-box agent writes server code) can serve the ask. */
const BOX_INSTRUCTION = /\b(custom (?:code|logic|parser|parsing|algorithm|scoring|dedup\w*)|write (?:a |an )?(?:parser|algorithm|script)|state machine|levenshtein|fuzzy[- ]?match\w*)\b/i;
/** Custom-code words that can also LABEL a visible element ("make the parse
 *  errors card blue", "show the ledger table"); same outside-a-label rule. */
const AMBIGUOUS_BOX_TERM = /\b(parse|parsing|parser|csv|xlsx|regex|algorithm|dedup\w*|de-dup\w*|reconcil\w*|ledger)\b/gi;
/** Escalation-ladder rung b — UNAMBIGUOUS per-run-judgment signals: each
 *  firing needs a model's call (who, which, what tone), but every effect is
 *  tool-reachable — the agentic automation run model, never a box. */
const AGENTIC_INSTRUCTION = /\b(decide|decides|deciding|judgment|judgement|discretion|deserv\w+|as appropriate|appropriately)\b/i;
/** Judgment words that can also LABEL a visible element ("rename the triage
 *  board"); same outside-a-label rule. */
const AMBIGUOUS_AGENTIC_TERM = /\b(triage|classify|prioriti[sz]e|assess|judge|escalate)\b/gi;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Models wrap output in prose or a markdown fence despite instructions
 *  (the deleted v1 JSON path had the same tolerance). The wire is
 *  everything from the first `<App` through the last `</App>` (or stream
 *  end while it is still open) — deterministic, so prefix compiles stay
 *  valid-while-partial. */
const extractWire = (text: string): string => {
  const start = text.indexOf("<App");
  if (start === -1) return text;
  const closeTag = "</App>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

// Anthropic prompt-caching breakpoint (mirrors packages/agent/src/agent.ts's
// CACHE_BREAKPOINT). providerOptions.anthropic is ignored by every other
// provider and by the test mocks, so marking the breakpoint degrades to a
// no-op off-Anthropic.
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** The generation prompt as a two-message model prompt with the stable prefix
 *  (the contract: role, tree/edit dialect, component catalog, host tool +
 *  field semantics, design rules) marked cacheable. The system message is the
 *  END of the stable prefix — identical across back-to-back generations for a
 *  deployment — so Anthropic re-reads it from cache instead of re-billing it.
 *  The user message is the per-request variable tail (the request / the app
 *  being edited / repair issues) and is deliberately left OUT of the cached
 *  prefix. WHAT the model sees is unchanged — only the prefix is marked. */
const cacheableGenerationMessages = (system: string, prompt: string): ModelMessage[] => [
  { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
  { role: "user", content: prompt },
];

/** Stream the wire, compiling each accumulated prefix (throttled) into a
 *  valid-while-partial tree for the onPartial seam. */
const streamWire = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
  hostComponents: readonly string[],
  timing?: { lane: GenerationTimingEvent["lane"]; thinking: boolean; startedAt: number },
): Promise<{ compiled?: WireCompileResult; raw?: string; issues: string[] }> => {
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = 0;
  let firstPartialAt = 0;
  const pending: Promise<void>[] = [];
  const reportTiming = (phase: "first-partial" | "complete", usage?: { inputTokens?: number; outputTokens?: number }): void => {
    if (deps.onTiming === undefined || timing === undefined) return;
    deps.onTiming({ lane: timing.lane, phase, atMs: Date.now() - timing.startedAt, thinking: timing.thinking, ...(usage === undefined ? {} : { usage }) });
  };
  const flush = (): void => {
    if (deps.onPartial === undefined) return;
    if (firstPartialAt === 0) { firstPartialAt = Date.now(); reportTiming("first-partial"); }
    lastFlushAt = Date.now();
    const compiled = compileWire(extractWire(text), wireCompileOptionsFor(deps, hostComponents));
    const partial: GeneratedPartial = {
      tree: compiled.tree,
      ...(compiled.name === undefined ? {} : { name: compiled.name }),
      ...(Object.keys(compiled.components).length === 0 ? {} : { components: compiled.components }),
    };
    pending.push(Promise.resolve(deps.onPartial(partial)).catch(() => undefined));
  };
  const schedule = (): void => {
    if (deps.onPartial === undefined) return;
    const remaining = Math.max(0, 100 - (Date.now() - lastFlushAt));
    if (lastFlushAt === 0 || remaining === 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      flush();
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, remaining);
    }
  };
  const finishPartials = async (): Promise<void> => {
    // A throttled flush may still be pending at stream end — deliver it so
    // the last pre-final prefix reaches the seam before the final document.
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      flush();
    }
    await Promise.all(pending);
  };
  try {
    const { streamText } = await import("ai");
    // streamText does NOT throw provider errors: its default onError logs the
    // raw error object and the text stream simply ends, so a model failure
    // (no key, missing @ai-sdk package, quota, timeout) used to reach the
    // caller as an unparseable-wire issue — unclassifiable downstream. Capture
    // the error here so the "model generation failed: …" issue carries the
    // real message (buildFailureReason classifies from it).
    let streamError: unknown;
    const result = streamText({
      model: deps.model,
      messages: cacheableGenerationMessages(system, prompt),
      ...modelCallParams(deps.model),
      maxRetries: 0,
      onError: ({ error }) => { streamError = error; },
    });
    for await (const delta of result.textStream) {
      text += delta;
      schedule();
    }
    await finishPartials();
    if (streamError !== undefined) {
      return { issues: [`model generation failed: ${streamError instanceof Error ? streamError.message : "unknown error"}`] };
    }
    // 0.4.4 cert defect A — a stream that completes with NO text at all is a
    // provider/gateway failure mode (observed live: a gateway alias with
    // forced extended thinking sometimes ends the turn reasoning-only), not a
    // malformed document. Naming it beats reporting the empty string's
    // compile issues ("wire missing-app…"), which read as a model-format
    // defect and sent the 0.4.4 triage down the wrong path.
    if (text.trim().length === 0) {
      return { issues: ["model generation failed: the model stream completed without any text output (empty or reasoning-only response from the provider)"] };
    }
    if (deps.onTiming !== undefined && timing !== undefined) {
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      reportTiming("complete", usage === undefined ? undefined : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    return { compiled: compileWire(extractWire(text), wireCompileOptionsFor(deps, hostComponents)), raw: extractWire(text), issues: [] };
  } catch (error) {
    await finishPartials();
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

/** Data-sighted verification (stages/verify.ts) at the runtime seam: the
 *  runtime resolves the app's queries after create and hands the ACTUAL
 *  values here, so labels get checked against the data the writer never saw.
 *  Same validator, same copy-only guard as the end pass — cannot break the
 *  app; on any failure the original document ships. */
export const verifyDocumentAgainstData = async (
  document: GeneratedAppDocument,
  userRequest: string,
  resolvedData: Record<string, unknown>,
  deps: GenerationDependencies,
): Promise<GeneratedAppDocument> => dataSightedVerify(document, userRequest, resolvedData, {
  deps,
  hostComponents: deps.catalog.map(({ name }) => name),
  startedAt: Date.now(),
  validate: (compiled) => validateCompiledCreate(compiled, deps, userRequest),
});

const withoutId = (app: AppDocument): GeneratedAppDocument => {
  const { id: _id, ...document } = structuredClone(app);
  return document;
};

export const distinctIssues = (current: string[], next: string[]): string[] => [
  ...new Set([...current, ...next]),
];

const insertChild = (parent: TreeNode, nodeId: string, index: unknown): void => {
  const children = parent.children ?? [];
  const position = typeof index === "number" && Number.isInteger(index)
    ? Math.max(0, Math.min(index, children.length))
    : children.length;
  children.splice(position, 0, nodeId);
  parent.children = children;
};

const repairPrompt = (issues: string[]): string =>
  issues.length === 0 ? "" : `\nREPAIR_THESE_ISSUES: ${JSON.stringify(issues)}`;

/** Raw-text model call for the edit dialect (no streaming seam: edits are
 *  small and apply atomically). */
const generateWireText = async (
  deps: GenerationDependencies,
  system: string,
  prompt: string,
): Promise<{ text?: string; issues: string[] }> => {
  try {
    const { streamText } = await import("ai");
    const result = streamText({
      model: deps.model,
      messages: cacheableGenerationMessages(system, prompt),
      ...modelCallParams(deps.model),
      maxRetries: 0,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    return { text, issues: [] };
  } catch (error) {
    return { issues: [`model generation failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
};

// ---------------------------------------------------------------------------
// demo-latency lane — island-scoped repair. Live finding (Maple, 2026-07-23):
// a whole 6-minute create failed because EVERY lane's output carried ONE
// fabricating island; structured repair has no island arm, so each failure
// cost a full ~60s re-generation that reproduced the same island class. When
// every validation issue is island-scoped, rewriting just those island
// sources (one small model call) converges faster and cheaper.
// ---------------------------------------------------------------------------

const ISLAND_ISSUE_NAME = /^island "([^"]+)"/;

/** Island issues a SOURCE rewrite cannot fix: a name collision needs the
 *  island renamed AND its tree references updated — tree surgery, so it stays
 *  with the free-form retry. */
const ISLAND_SOURCE_UNFIXABLE = /would never render/;

/** The offending island names when EVERY issue is island-scoped (each issue
 *  string starts `island "<name>"` — the one prefix all island validators
 *  share) and source-fixable; undefined as soon as any issue lies outside
 *  that closed class. */
export const islandIssueNames = (issues: readonly string[]): string[] | undefined => {
  const names = new Set<string>();
  for (const issue of issues) {
    const match = ISLAND_ISSUE_NAME.exec(issue);
    if (match === null || ISLAND_SOURCE_UNFIXABLE.test(issue)) return undefined;
    names.add(match[1] as string);
  }
  return names.size === 0 ? undefined : [...names];
};

const islandRepairContract = (deps: GenerationDependencies): string => composePromptSections([{
  id: "role",
  content: `You are the Vendo island repair engine. An app compiled and validated cleanly EXCEPT for the generated <Island> components named in ISLANDS_TO_FIX. Rewrite ONLY those islands so every VALIDATION_ISSUE is fixed while keeping each island's purpose and look. Return ONLY the corrected <Island name="...">TSX</Island> elements — the same names, one element per island — with no prose, no markdown fences, no <App> wrapper, and no other markup. Honesty rules: every number or row an island renders comes from its props or an ambient tools read — when the host has no tool for a value, render an honest "not available" note instead of inventing data or constants.`,
}, {
  id: "tree-contract",
  content: islandContract(),
}, ...hostToolSections(deps)]);

/** Rewrite the offending islands, splice the corrected sources back into the
 *  otherwise-clean document, and revalidate whole. Returns no document when
 *  the issues are outside the island-only class, the model call fails, or the
 *  spliced document still fails validation — the caller's normal fallback
 *  (free-form retry / resident paint) proceeds unchanged. */
export const repairIslandsScoped = async (
  compiled: WireCompileResult,
  issues: string[],
  userRequest: string,
  context: PipelineContext,
): Promise<{ document?: GeneratedAppDocument }> => {
  const names = islandIssueNames(issues);
  if (names === undefined) return {};
  if (!names.every((name) => typeof compiled.components[name] === "string")) return {};
  const { deps } = context;
  const repairStart = Date.now();
  // Issues still outstanding if this stage fails: the incoming ones until the
  // rewritten islands are revalidated (a stage that fixed nothing leaves the
  // originals standing), the residual ones after.
  let pending: readonly string[] = issues;
  const finish = (document?: GeneratedAppDocument): { document?: GeneratedAppDocument } => {
    deps.onPipeline?.({
      stage: "island-repair",
      islands: names.length,
      repaired: document !== undefined,
      ms: Date.now() - repairStart,
      ...(document !== undefined || pending.length === 0 ? {} : { issues: [...pending] }),
    });
    return document === undefined ? {} : { document };
  };
  const base = {
    tree: compiled.tree,
    components: compiled.components,
    ...(compiled.name === undefined ? {} : { name: compiled.name }),
  };
  const output = await generateWireText(
    deps,
    islandRepairContract(deps),
    [
      `USER_REQUEST: ${userRequest}`,
      `CURRENT_APP (context only — do NOT re-emit it; everything outside the named islands is already valid):`,
      printWire(base, { includeIds: false }),
      `ISLANDS_TO_FIX: ${names.join(", ")}`,
      `VALIDATION_ISSUES:`,
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"),
  );
  deps.onTiming?.({ lane: "repair", phase: "complete", atMs: Date.now() - context.startedAt, thinking: false });
  if (output.text === undefined) return finish();
  // The reply is bare <Island> elements; models sometimes wrap in an <App> or
  // fences anyway — the wire compiler extracts islands from either shape.
  const text = output.text.replaceAll(/```[a-z]*\n?/gi, "");
  const fixesWire = text.includes("<App") ? extractWire(text) : `<App name="__island_repair__">${text}</App>`;
  const fixes = compileWire(fixesWire, wireCompileOptionsFor(deps, [...context.hostComponents]));
  const nextComponents: Record<string, string> = { ...compiled.components };
  let replaced = 0;
  for (const name of names) {
    const source = fixes.components[name];
    if (typeof source === "string" && source.trim() !== "") {
      nextComponents[name] = source;
      replaced += 1;
    }
  }
  if (replaced === 0) return finish();
  const recompiled = compileWire(
    printWire({ ...base, components: nextComponents }, { includeIds: false }),
    wireCompileOptionsFor(deps, [...context.hostComponents]),
  );
  const validated = await context.validate(recompiled);
  pending = validated.issues;
  return finish(validated.document);
};

/** The deterministic fork core (06-apps §8): copies the TRUSTED captured
 *  baseline into the named generated component, mints and attaches the node,
 *  and records the pin — no model involvement, source is never retyped.
 *  Gesture-owned forking (2026-07-21): the runtime's pins.fork surface is the
 *  primary caller (the user's Remix gesture); the <ForkPin> extension op keeps
 *  compiling for stored apps but is no longer taught to the model. */
export const applyPinFork = (
  app: AppDocument,
  props: Record<string, unknown>,
  pinBaselines: readonly PinBaseline[] | undefined,
): string[] => {
  const fail = (message: string): string[] => [`<ForkPin> failed: ${message}`];
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
  const tree = app.tree as unknown as Tree;
  const parentId = props.into === undefined ? tree.root : props.into;
  if (typeof parentId !== "string") return fail("into must be a string node id when present");
  const parent = tree.nodes.find(({ id }) => id === parentId);
  if (parent === undefined) return fail(`parent "${parentId}" does not exist`);
  if (props.at !== undefined && (typeof props.at !== "number" || !Number.isInteger(props.at) || props.at < 0)) {
    return fail("at must be a non-negative integer when present");
  }
  // Compiler-owned id discipline: mint past the existing ordinals, exactly
  // like an <Insert> would.
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

const editTree = async (
  input: GenerationEditInput,
  deps: GenerationDependencies,
): Promise<GenerationEditResult> => {
  if (input.app.tree?.formatVersion !== VENDO_TREE_FORMAT) {
    return { kind: "failure", issues: ["tree edits require a vendo-genui/v2 app"] };
  }
  const hostComponents = deps.catalog.map(({ name }) => name);
  const base = {
    tree: input.app.tree as unknown as Tree,
    components: input.app.components ?? {},
    name: input.app.name,
  };
  const context = printWire(base, { includeIds: true });
  let issues = [...(input.repairIssues ?? [])];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await generateWireText(
      deps,
      editContract(deps),
      `TASK: EDIT_TREE\nINSTRUCTION: ${input.instruction}\nCURRENT_APP (wire markup; id attributes are your anchors):\n${context}\nAPP_META: ${JSON.stringify({ name: input.app.name, description: input.app.description ?? null, pins: input.app.pins ?? [] })}${repairPrompt(issues)}`,
    );
    issues = distinctIssues(issues, output.issues);
    if (output.text !== undefined) {
      const patched = compileWirePatch(extractEdit(output.text), base, {
        hostComponents,
        ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
        extensionOps: ["ForkPin", "SetDescription"],
      });
      const patchIssues = [
        ...(patched.complete ? [] : ["wire did not parse to a complete <Edit> document"]),
        ...patched.issues.map(({ code, message }) => `wire ${code}: ${message}`),
      ];
      if (patchIssues.length === 0) {
        const app: AppDocument = {
          ...structuredClone(input.app),
          ...(patched.name === undefined ? {} : { name: patched.name }),
          tree: structuredClone(patched.tree) as unknown as NonNullable<AppDocument["tree"]>,
        };
        // Model islands go through the same ambient contract as create
        // (strip + tools scan + manifest restamp). PINNED components are
        // captured host source on the furnishing trust path: their real
        // imports resolve through the captured tables, so they are neither
        // stripped nor scanned — and get NO ambient-tools manifest.
        const pinnedNames = new Set((input.app.pins ?? []).map((pin) => pinComponentName(pin.slot)));
        const isPinned = ([componentName]: [string, string]) => pinnedNames.has(componentName);
        const splitIslands = (all: Record<string, string>) => ({
          pinned: Object.fromEntries(Object.entries(all).filter(isPinned)),
          model: Object.fromEntries(Object.entries(all).filter((entry) => !isPinned(entry))),
        });
        const patchedIslands = splitIslands(patched.components);
        // The edit instruction is the user text in scope here; both prepares
        // get the SAME text so a carried-over issue stays byte-identical for
        // the pre-existing-issue filter below.
        const prepared = await prepareIslands(patchedIslands.model, deps.tools, hostComponents, input.instruction);
        // Pre-existing island issues never block an unrelated edit (same
        // filtering rule as catalog/action issues in validateEditedApp).
        const sourcePrepared = await prepareIslands(splitIslands(input.app.components ?? {}).model, deps.tools, hostComponents, input.instruction);
        const sourceIslandIssues = new Set(sourcePrepared.issues);
        const islandIssues = prepared.issues.filter((issue) => !sourceIslandIssues.has(issue));
        const nextComponents = { ...patchedIslands.pinned, ...prepared.components };
        if (Object.keys(nextComponents).length === 0) {
          delete app.components;
          delete app.componentTools;
        } else {
          app.components = structuredClone(nextComponents);
          app.componentTools = structuredClone(prepared.componentTools);
        }
        const extensionIssues: string[] = [];
        const changed = patched.appliedOps > 0 || patched.extensionOps.length > 0;
        for (const extension of patched.extensionOps) {
          if (extension.op === "SetDescription") {
            if (typeof extension.props.text !== "string") {
              extensionIssues.push("<SetDescription> needs a string text attribute");
            } else {
              app.description = extension.props.text;
            }
            continue;
          }
          extensionIssues.push(...applyPinFork(app, extension.props, deps.pinBaselines));
        }
        if (!changed) extensionIssues.push("the patch contained no effective ops; emit at least one op for the instruction");
        // A <ForkPin> in this patch may have added a pinned component after
        // the manifest restamp above. Keep componentTools DEFINED whenever
        // components exist, so the renderer's stamped-era rule (missing key
        // = zero tools) applies instead of the source-scan fallback.
        if (app.components !== undefined && app.componentTools === undefined) {
          app.componentTools = {};
        }
        if (extensionIssues.length === 0) {
          const validationIssues = [...islandIssues, ...await validateEditedApp(app, deps, input.app, input.instruction)];
          if (validationIssues.length === 0) {
            return { kind: "document", document: withoutId(app) };
          }
          issues = distinctIssues(issues, validationIssues);
        } else {
          issues = distinctIssues(issues, extensionIssues);
        }
      } else {
        issues = distinctIssues(issues, patchIssues);
      }
    }
  }
  return { kind: "failure", issues: issues.length === 0 ? ["tree edit failed validation"] : issues };
};

/**
 * Page-open prewarm. Pays the provider import + TLS/keep-alive connection
 * cost up front with a throwaway 1-token generation so the first real create
 * reuses a live socket instead of opening one cold. Best-effort: any failure
 * (no key, offline) is swallowed. Measured effect on first-paint is small
 * (model time-to-first-token dominates), so this is a cheap worst-case
 * guard, not a headline win — see docs/verification/vendo-v2-speed.
 */
export const prewarmModels = async (models: readonly LanguageModel[]): Promise<void> => {
  const { generateText } = await import("ai");
  await Promise.all(
    models.map((model) => generateText({ model, prompt: "ok", maxOutputTokens: 1, maxRetries: 0 }).then(() => undefined).catch(() => undefined)),
  );
};

/** Compile INFO, never an error: a NEW create that emits a deprecated
 *  reshape op still compiles (stored apps depend on the ops), but each
 *  distinct usage logs one observable line so live traffic tells us when
 *  deletion is safe. */
const logDeprecatedDialect = (document: GeneratedAppDocument): GeneratedAppDocument => {
  for (const notice of findDeprecatedReshapeUsage(document.tree)) {
    console.info(`[vendo] INFO generated app "${document.name}" uses a ${notice} (kept compiling for stored apps; W5a staged retirement)`);
  }
  return document;
};

/** A provider-form designRules is resolved ONCE per create/edit, so the
 *  paint/retry/repair prompts within one generation never mix rule sets; the
 *  next generation re-resolves. */
const snapshotDesignRules = (deps: GenerationDependencies): GenerationDependencies =>
  typeof deps.designRules === "function" ? { ...deps, designRules: deps.designRules() } : deps;

/** demo-latency lane — per-attempt observability: a failed lane's issues were
 *  invisible unless the WHOLE create failed, so a 6-minute create that burned
 *  three invalid attempts read as silence. One compact operator line per
 *  invalid lane result; full issue lists still ride the final VendoError. */
const logInvalidLane = (lane: string, issues: readonly string[]): void => {
  if (issues.length === 0) return;
  const preview = issues.slice(0, 3).map((issue) => issue.split(" — ")[0]).join(" | ");
  console.info(`[vendo] gen ${lane} invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${preview.slice(0, 360)}`);
};

/** 06-apps §§2,5 — wire-backed rung-1 generation and two-dialect edit
 *  planning. */
export const modelEngine: GenerationEngine = {
  async create(input, rawDeps) {
    const deps = snapshotDesignRules(rawDeps);
    const startedAt = Date.now();
    const hostComponents = deps.catalog.map(({ name }) => name);
    const basePrompt = `TASK: CREATE_APP\nUSER_REQUEST: ${input.prompt}`;
    // Island-scoped repair budget, shared by EVERY path that rewrites islands
    // (the region-parallel assembly rescue and the create loop below), so the
    // bounded worst case holds whichever path spends it (checker F3): at most
    // 2 island rewrites per create, then one full retry + a structured round.
    let islandRepairRounds = 2;
    // Pipeline context: structured repair / region-parallel / end pass all
    // validate through the ONE create validator; the island-scoped repair
    // rides along so the region-parallel path can rescue island-only failures.
    const pipelineContext: PipelineContext = {
      deps,
      hostComponents,
      startedAt,
      validate: (compiled) => validateCompiledCreate(compiled, deps, input.prompt),
      repairIslands: (compiled, repairIssues) => {
        logInvalidLane("assembly", repairIssues);
        if (islandRepairRounds <= 0) return Promise.resolve({});
        islandRepairRounds -= 1;
        return repairIslandsScoped(compiled, repairIssues, input.prompt, pipelineContext);
      },
    };
    // demo-latency lane — one shared, MONOTONIC partial gate for every lane:
    // the painted surface never regresses to a smaller prefix, whichever lane
    // (tier-0 paint, section assembly, full stream) produced it. This is what
    // lets the paint lane run CONCURRENTLY with region-parallel instead of
    // serializing ~20-60s ahead of it. `settled` closes the gate the moment a
    // final document is chosen, so a still-streaming slower lane can never
    // repaint over the final emit.
    const forward = deps.onPartial;
    let bestNodes = 0;
    let settled = false;
    const gatedPartial = forward === undefined ? undefined : (partial: GeneratedPartial): void => {
      if (settled || partial.tree.nodes.length < bestNodes) return;
      bestNodes = partial.tree.nodes.length;
      void Promise.resolve(forward(partial)).catch(() => undefined);
    };
    const gatedDeps: GenerationDependencies = gatedPartial === undefined ? deps : { ...deps, onPartial: gatedPartial };
    const finish = (document: GeneratedAppDocument): Promise<GeneratedAppDocument> => {
      settled = true;
      return endPass(document, input.prompt, pipelineContext).then(logDeprecatedDialect);
    };
    // Tier-0 paint lane: only with a streaming consumer — the instant paint
    // exists to reach a screen. One attempt, no repair loop: an invalid
    // paint is simply not resident (the full lane still runs).
    let resident: GeneratedAppDocument | undefined;
    let residentLayout: string | undefined;
    const paintPromise: Promise<void> = deps.onPartial !== undefined && deps.paint?.disabled !== true
      ? (async () => {
        const paintDeps = deps.paint?.model === undefined ? gatedDeps : { ...gatedDeps, model: deps.paint.model };
        const paint = await streamWire(paintDeps, tier0Contract(deps), basePrompt, hostComponents, { lane: "paint", thinking: false, startedAt });
        if (paint.compiled !== undefined) {
          const validated = await validateCompiledCreate(paint.compiled, deps, input.prompt);
          if (validated.document !== undefined) {
            resident = validated.document;
            residentLayout = layoutHeader(paint.compiled);
          } else {
            logInvalidLane("paint", validated.issues);
          }
        }
      })().catch(() => undefined)
      : Promise.resolve();
    // Outline + region-parallel tier-2 (flagged), running CONCURRENTLY with
    // the paint lane (neither conditions on the other; the monotonic gate
    // arbitrates the painted surface). Any planning/section/assembly failure
    // falls through to the single-stream loop below: parallel is an
    // optimization, never a gate.
    if (deps.pipeline?.regionParallel === true) {
      const parallel = await regionParallelCreate(pipelineContext, {
        userRequest: input.prompt,
        generateSection: async (prompt) => {
          const output = await streamWire(
            // Section streams bypass onPartial (the assembled prefix is
            // emitted on section completion below) but keep the model/deps.
            { ...deps, onPartial: undefined },
            createContract(deps),
            prompt,
            hostComponents,
            { lane: "section", thinking: false, startedAt },
          );
          return output.raw;
        },
        ...(gatedPartial === undefined ? {} : {
          emitPartial: (assembledWire: string) => {
            const compiled = compileWire(assembledWire, wireCompileOptionsFor(deps, hostComponents));
            gatedPartial({
              tree: compiled.tree,
              ...(compiled.name === undefined ? {} : { name: compiled.name }),
              ...(Object.keys(compiled.components).length === 0 ? {} : { components: compiled.components }),
            });
          },
        }),
      });
      if (parallel.document !== undefined) return finish(parallel.document);
    }
    // The single-stream lane conditions on the paint layout (TIER0_LAYOUT →
    // stable minted ids → in-place hot-swap), so it awaits the paint lane —
    // with region-parallel on, the paint finished long ago; without it, this
    // is exactly the old serial order.
    await paintPromise;
    let issues: string[] = [];
    // Structured repair budget: at most 2 strict rounds per create, then the
    // free-form regeneration loop takes over. Island-scoped repair is the
    // FIRST resort (speed-core): when EVERY issue is island-scoped and
    // source-fixable, the shared island budget (declared with the pipeline
    // context above) is drained before any ~60s full-lane regeneration; a
    // budget that exhausts without converging caps the ladder at ONE further
    // full-lane retry whose structured round gains the island-disclaim arm —
    // the signed bounded worst case: exhaustion → one retry → a structured
    // repair round. Regenerating the whole app kept reproducing the same
    // island class in the 5-9 minute live failures.
    let repairRounds = deps.pipeline?.structuredRepair === false ? 0 : 2;
    let attemptCap = 3;
    for (let attempt = 0; attempt < attemptCap; attempt += 1) {
      const attemptStart = Date.now();
      const emitFull = (valid: boolean, attemptIssues: readonly string[] = []): void => {
        deps.onPipeline?.({
          stage: "full",
          attempt,
          valid,
          ms: Date.now() - attemptStart,
          ...(valid || attemptIssues.length === 0 ? {} : { issues: [...attemptIssues] }),
        });
      };
      const output = await streamWire(
        gatedDeps,
        createContract(deps),
        `${basePrompt}${residentLayout === undefined
          ? ""
          : `\nTIER0_LAYOUT: ${residentLayout}\nAn instant paint pass already rendered that layout. Emit the full-quality app; keep the top-level component ordering compatible where reasonable so minted node ids stay stable and the upgrade swaps in place.`}${repairPrompt(issues)}`,
        hostComponents,
        { lane: "full", thinking: false, startedAt },
      );
      issues = distinctIssues(issues, output.issues);
      if (output.compiled !== undefined) {
        const validated = await validateCompiledCreate(output.compiled, deps, input.prompt);
        emitFull(validated.document !== undefined, validated.issues);
        if (validated.document !== undefined) return finish(validated.document);
        logInvalidLane("full", validated.issues);
        issues = distinctIssues(issues, validated.issues);
        // speed-core — when EVERY issue is island-scoped, rewrite just those
        // islands (one small call per round, before any full-lane retry)
        // instead of burning another ~60s full-lane attempt on the same
        // failure class. Island issues are invisible to the structured
        // repair's closed fix space (it derives from the compile result
        // alone), so they only reach it through the disclaim arm below.
        let islandDisclaimNames: string[] | undefined;
        const islandNames = islandIssueNames(validated.issues);
        if (islandNames !== undefined) {
          if (islandRepairRounds > 0) {
            while (islandRepairRounds > 0) {
              islandRepairRounds -= 1;
              const islandRepaired = await repairIslandsScoped(output.compiled, validated.issues, input.prompt, pipelineContext);
              if (islandRepaired.document !== undefined) return finish(islandRepaired.document);
            }
            // Exhausted without converging: at most ONE further full-lane
            // retry, never the remaining attempt ladder.
            attemptCap = Math.min(attemptCap, attempt + 2);
          } else {
            // The post-exhaustion attempt reproduced the island class: this
            // attempt's structured round runs WITH the island-disclaim arm —
            // the bounded sequence's terminal round.
            islandDisclaimNames = islandNames;
            attemptCap = Math.min(attemptCap, attempt + 2);
          }
        }
        if (repairRounds > 0) {
          const repaired = await structuredRepair(output.compiled, input.prompt, pipelineContext, repairRounds, islandDisclaimNames);
          repairRounds -= repaired.rounds;
          if (repaired.document !== undefined) return finish(repaired.document);
          issues = distinctIssues(issues, repaired.issues);
        }
      } else {
        // No compiled document at all: the stream/compile issues ARE the reason.
        emitFull(false, output.issues);
      }
    }
    // Never a white box: a failed full lane falls back to the resident
    // tier-0 app.
    settled = true;
    if (resident !== undefined) return logDeprecatedDialect(resident);
    throw new VendoError("validation", "model could not produce a valid app", issues);
  },
  async edit(input, deps) {
    // The engine only patches the tree. Server work is the in-box agent's
    // job (graduation, runtime.machine.editApp); the tree gains its fn:
    // bindings through this same tree-edit path afterward.
    return editTree(input, snapshotDesignRules(deps));
  },
};

/**
 * The graduation judgment: whether an instruction needs server capability
 * (scheduled/background work, third-party egress, heavy logic, app-owned
 * state) and so must ride the in-box agent (runtime graduates 1→2, delegates
 * the server work to the box, then lands fn: bindings via the tree-edit
 * path). A false answer keeps the edit on the pure tree path. Ambiguous
 * words like "api" or "function" count only when they are not labeling a
 * visible element — "make the API status card blue" must stay on the cheap
 * tree path.
 */
export const instructionRequiresServer = (app: Pick<AppDocument, "ui">, instruction: string): boolean =>
  SERVER_INSTRUCTION.test(instruction)
  || SERVED_APP_INSTRUCTION.test(instruction)
  || app.ui === "http"
  || matchesOutsideElementLabel(instruction, AMBIGUOUS_SERVER_TERM);

/** The visible-element rule as a helper: an ambiguous term counts only when
 *  it is not labeling a visible element ("watch my invoices" escalates; "the
 *  watch list" stays on the cheap tree path). */
const matchesOutsideElementLabel = (instruction: string, term: RegExp): boolean =>
  [...instruction.matchAll(term)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));

/**
 * The server-work ESCALATION LADDER (the economics ruling: box graduation
 * costs minutes of model round trips; the existing automations engine covers
 * most server-shaped needs in seconds). For a server-shaped instruction the
 * runtime prefers, in order:
 *
 *   (a) "steps"   — expressible as deterministic tool calls (host + connected
 *                   tools + existing fn: refs) with jsonata reshaping, forEach,
 *                   and park/resume approval gates. A steps automation on the
 *                   EXISTING automations engine; no machine.
 *   (b) "agentic" — needs per-run judgment, but every effect is tool-reachable.
 *                   An agentic automation (the agent-loop run model); no machine.
 *   (c) "box"     — only when actual custom code is required (real computation,
 *                   libraries, complex persistent state, non-tool-shaped egress,
 *                   latency-sensitive logic). Box graduation — EXPERIMENTAL,
 *                   gated by `experimentalMachines`.
 *
 * `null` means the instruction is not server-shaped at all (pure tree path).
 * Same judge shape as {@link instructionRequiresServer}: deterministic word
 * classes with the visible-element rule for ambiguous terms. A served
 * (ui: "http") app is always box-shaped — its whole surface lives in its
 * machine.
 */
export const serverWorkRung = (
  app: Pick<AppDocument, "ui">,
  instruction: string,
): "steps" | "agentic" | "box" | null => {
  if (app.ui === "http") return "box";
  if (BOX_INSTRUCTION.test(instruction) || matchesOutsideElementLabel(instruction, AMBIGUOUS_BOX_TERM)) {
    return "box";
  }
  if (AGENTIC_INSTRUCTION.test(instruction) || matchesOutsideElementLabel(instruction, AMBIGUOUS_AGENTIC_TERM)) {
    return "agentic";
  }
  return instructionRequiresServer(app, instruction) ? "steps" : null;
};

/**
 * The 2→3 escalation judgment (same judge shape as
 * {@link instructionRequiresServer}): whether an instruction's UI needs exceed
 * the tree, so the box agent must build a REAL web app the machine serves
 * (layer 3, experimental — the runtime refuses this path unless the host
 * enabled `experimentalServedApps`). An already-served app is always a
 * layer-3 subject: every edit of it is served-app work.
 */
export const instructionRequiresServedApp = (
  app: Pick<AppDocument, "ui">,
  instruction: string,
): boolean =>
  app.ui === "http"
  || SERVED_APP_INSTRUCTION.test(instruction)
  || [...instruction.matchAll(AMBIGUOUS_SERVED_TERM)].some((match) =>
    !VISIBLE_ELEMENT_LABEL.test(instruction.slice(match.index + match[0].length).trimStart()));
