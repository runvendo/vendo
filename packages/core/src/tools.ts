import { z } from "zod";
import { approvalIdSchema, jsonSchemaSchema, type ApprovalId, type Json, type JsonSchema } from "./ids.js";
import type { RunContext } from "./run-context.js";

const requiredJsonValueSchema = z.unknown().refine(
  (value) => value !== undefined,
  { message: "required JSON value is missing" },
) as z.ZodType<{}>;

/** 01-core §4 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 01-core §4/§16 — the app runtime's reserved agent-tool namespace. Tools
 *  under this prefix are the only ones whose ok-outcome may carry an
 *  OpenSurface onto the view channel; the agent bridge and the apps runtime
 *  both read this constant so the seam is named once, here, instead of each
 *  side string-matching the other. */
export const VENDO_APPS_TOOL_PREFIX = "vendo_apps_";

/**
 * The ONE public tool for asking Vendo to make something to look at.
 *
 * It replaces `vendo_apps_create` and `vendo_apps_edit`. Two tools meant every
 * calling agent — ours, a host's own SDK agent, an outside agent over MCP — had to
 * decide "new or change?" before it could ask, and get it right. That is our
 * routing decision, not theirs: the seam knows whether an app exists, and a caller
 * that wants a specific one says so with `app`.
 *
 * Named here, outside the `vendo_apps_` prefix, because it is the front door
 * rather than a member of the app runtime's family — and `isVendoAppsTool` below
 * is what keeps the family's laws applying to it.
 */
export const VENDO_MAKE_TOOL = "vendo_make";

/**
 * The two tools that put one of a person's own apps into a named place on the
 * HOST'S page, and take it back out.
 *
 * Named here for the same reason `VENDO_MAKE_TOOL` is: three sides read them and
 * a security-relevant name with three spellings drifts silently — the apps
 * registry that implements them, the projection below that withholds them from
 * an unattended run, and any door that names them in `withholdTools`.
 */
export const VENDO_APPS_PIN_TOOL = "vendo_apps_pin";
export const VENDO_APPS_UNPIN_TOOL = "vendo_apps_unpin";

/**
 * Tools whose whole effect is on a PERSON'S SCREEN.
 *
 * §12's projection withholds these from an unattended run exactly as it
 * withholds a destructive one, for a reason of the same shape: there is no page
 * and nobody looking at it. A firing that rearranged someone's dashboard while
 * they were away would be a change they never asked for and never saw being
 * made — and, because a placement EVICTS whatever held that slot, one they would
 * come back to without knowing what happened.
 *
 * Keyed on the NAME rather than on the grade, because the grade is honestly
 * `write`: with a person right there, putting your own app on your own page is a
 * small reversible write that needs no ceremony. Grading them `destructive` to
 * buy the withholding would lie to every other reader of the label (policy
 * rules, the consent card, the automations planner).
 */
export const PRESENCE_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_UNPIN_TOOL,
]);

/**
 * 01-core §16 — is this one of the app runtime's own tools?
 *
 * The prefix was the test in four places (two through the constant, two by
 * hand-written string), and each one gates something different: whether an
 * ok-outcome may put a tree on the view channel, whether the transcript renders a
 * build card, whether the router's "what else can I do" menu lists it, whether an
 * automation plan may call it. `vendo_make` sits outside the prefix, so a fourfold
 * prefix check would have silently dropped every one of those laws for the one
 * tool they matter most for. One predicate, one place to state the law.
 */
export const isVendoAppsTool = (name: string): boolean =>
  name === VENDO_MAKE_TOOL || name.startsWith(VENDO_APPS_TOOL_PREFIX);

/**
 * The consumer-voice titles for the tools VENDO ITSELF projects (design §3:
 * "surfaces render tool titles and verbs, never names — rendering-layer law").
 *
 * ONE table, because two sides must say the same words and neither can read the
 * other's copy. Server-side, each descriptor authors its `title` from here, so
 * `ToolListing.title` stops falling back to the identifier and the model is
 * never handed `vendo_apps_open` as a tool's human label. Client-side, the
 * render layer has no descriptor at all for a progress chip or an activity row —
 * the wire tool part carries only a name — so it reads the same table rather
 * than prettifying our own namespace into "Vendo apps edit…" (wave-1 live proof
 * E1-5).
 *
 * Host tools are NOT here: a host authors its own titles (sync enrichment,
 * `.vendo/overrides.json`), and inventing labels for someone else's API would be
 * a guess. This table covers only what Vendo ships.
 */
export const VENDO_TOOL_TITLES: Readonly<Record<string, string>> = {
  vendo_make: "Make you a screen",
  vendo_apps_open: "Open the app",
  vendo_apps_rebase_pin: "Refresh a remixed piece",
  vendo_apps_pin: "Pin the app to your page",
  vendo_apps_unpin: "Take the app off your page",
  vendo_apps_data_list: "Read the app's saved items",
  vendo_apps_data_put: "Save an item in the app",
  vendo_apps_data_delete: "Remove an item from the app",
  vendo_knowledge_search: "Look it up in the docs",
  // The verbs and `ask_user` authored these titles inline first; they moved here
  // verbatim so the CLIENT can say them too. A live browser proof caught the gap:
  // `search_components` narrated "Search components…" — its identifier
  // prettified — while its descriptor carried "Look up available components".
  validate: "Check the app for mistakes",
  search_components: "Look up available components",
  schedule: "Set when this runs",
  ask_user: "Ask you a question",
  find_service_tools: "Look for an outside service",
  use_service_tool: "Use an outside service",
  list_connections: "Check your connected services",
  request_connection: "Ask you to connect a service",
  // Meta-tools: ai-SDK `dynamicTool`s with no descriptor at all, so the table is
  // their ONLY title. The reporter fires on the honest-refusal path — the very
  // turn the §3 leak was photographed on — and read "Vendo report capability
  // miss…".
  find_tools: "Look for the right tool",
  vendo_report_capability_miss: "Note what I can't do",
};

/**
 * The description a MODEL is given for one tool: its human title first, then the
 * operational text.
 *
 * §3's voice law is a rendering-layer law, and a model is the surface that writes
 * a refusal or an explanation — it can only say a title it was told. Handed only
 * `description`, the identifier is the sole proper noun in its context, which is
 * how a live refusal reached a user reading `` `host_transferMoney` `` (wave-1
 * proof E1-5). The identifier stays the CALL name; this is the one place the
 * human label enters the model's vocabulary.
 *
 * A title equal to the name adds nothing (`ToolListing.title` falls back to the
 * name) and would teach exactly the wrong vocabulary, so it is dropped.
 */
export function modelToolDescription(
  tool: { name: string; title?: string; description: string },
): string {
  const title = tool.title?.trim();
  return title === undefined || title === "" || title === tool.name
    ? tool.description
    : `${title} — ${tool.description}`;
}

/** 0.4.4 cert defect B — the message prefix the apps runtime stamps on a
 *  terminally failed BUILD's error ("app build failed: <classified reason>").
 *  The agent loop reads it to end the turn and raise the failed-build banner;
 *  named once here so neither side string-matches the other. Only this class
 *  ends a turn — a cheap create error (input validation, feature-flag
 *  refusal) stays the model's to handle. */
export const VENDO_APP_BUILD_FAILED_PREFIX = "app build failed";

/** 01-core §4 — a grade someone actually assigned. `ungraded` is the absence
 *  of one, so it is not a rung here: nothing may author "I don't know". */
export type GradedRiskLabel = "read" | "write" | "destructive";

/** Design §4 — the one question door, any seat.
 *
 *  The name lives in core because two sides read it and a security-relevant
 *  name with two definitions drifts silently: the registry that implements it,
 *  and the loop that ends a turn on it. */
export const ASK_USER_TOOL = "ask_user";

/** The connector dispatcher (connector-discovery design 2026-08-03) — the one
 *  tool whose real action is an ARGUMENT rather than its name, because a single
 *  name stands in for a third-party catalog of ~20,000 tools.
 *
 *  It lives here for the same reason `ASK_USER_TOOL` does, and one more: the
 *  grant law below has to recognise it. "Allow this tool" means twenty thousand
 *  actions on this one name and nothing like that on any other, so consent is
 *  keyed on the slug (see {@link GrantScope}'s `service-tool`) — a rule three
 *  packages read and none of them may spell differently. */
export const USE_SERVICE_TOOL = "use_service_tool";

/** The four permanent connector-discovery names (design 2026-08-03) — the whole
 *  door onto a broker's catalog, however many tens of thousands of tools it holds.
 *
 *  Beside {@link USE_SERVICE_TOOL} because a THIRD side reads them: the loadout.
 *  Not one of them carries the `vendo_*` prefix the always-active exemption keys
 *  on, so a host with more tools than the initial cap — or any curated
 *  `surfaces.agent` menu — silently dropped `request_connection` and
 *  `list_connections` while the system prompt went on teaching both (uiaudit
 *  2026-08-06). These are Vendo's own tools, not host API tools that explode in
 *  number, so they are exempt like the rest of ours. */
export const CONNECTOR_DISCOVERY_TOOLS = [
  "find_service_tools",
  USE_SERVICE_TOOL,
  "list_connections",
  "request_connection",
] as const;

/** 01-core §4 */
export const gradedRiskLabelSchema = z.enum(["read", "write", "destructive"]) satisfies z.ZodType<GradedRiskLabel>;

/** 01-core §4 — `ungraded` is explicit, not absence: a tool nobody (human,
 *  judge, or protocol fact) has graded says so on the wire, and the guard's
 *  default treats it like `destructive` and asks. */
export type RiskLabel = GradedRiskLabel | "ungraded";

/** 01-core §4 */
export const riskLabelSchema = z.enum(["read", "write", "destructive", "ungraded"]) satisfies z.ZodType<RiskLabel>;

/** 01-core §4 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** The tool's DECLARED result shape — extraction captures it from the host's
   *  own contract (an OpenAPI 2xx `application/json` schema today) and never
   *  invents one. Surfaces hand it to the model so a query's data fields are
   *  known before any call, instead of learned by calling once and reading rows. */
  outputSchema?: JsonSchema;
  risk: RiskLabel;
  /** Governance, not severity: this call needs a PERSON, every time. Checked
   *  before rules, grants, and the judge, and none of them can suppress it —
   *  each call earns its own input-bound, single-use approval. Orthogonal to
   *  `risk`, which is a fact about what the action does. Host-authored files
   *  may still spell it `critical` (its pre-rename name). */
  confirmEach?: boolean;
  /** A short human label for the surfaces that show this tool to a PERSON —
   *  MCP clients' tool menus, approval cards. Presentation only: it never
   *  changes what the tool can do, and absent it those surfaces fall back to
   *  `name`. Sync's AI enrichment proposes it; `.vendo/overrides.json`
   *  corrects it. */
  title?: string;
  /** The connectable toolkit this tool belongs to (04-actions §3), present
   *  only on connector tools whose usefulness is gated by a per-user connected
   *  account (e.g. Composio's gmail/slack). Composition seams read it to skip
   *  work that is pointless without a connection — the apps runtime's
   *  create-time shape probes skip unconnected toolkits (re-gate 2026-07-26
   *  finding 2). Metadata only: it never changes what the tool can do, and
   *  execution still answers `connect-required` on its own. */
  toolkit?: string;
}

/** 01-core §4 */
export const toolDescriptorSchema = z.object({
  name: z.string().regex(TOOL_NAME_PATTERN),
  description: z.string(),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema.optional(),
  risk: riskLabelSchema,
  confirmEach: z.boolean().optional(),
  title: z.string().optional(),
  toolkit: z.string().optional(),
}).passthrough() satisfies z.ZodType<ToolDescriptor>;

/** 01-core §4 */
export interface ToolCall {
  id: string;
  tool: string;
  args: Json;
}

/** 01-core §4 */
export const toolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: requiredJsonValueSchema,
}).passthrough() satisfies z.ZodType<ToolCall>;

/** Additive composition hook: resolve a call's effective risk before policy
 * rules, grants, breakers, and approvals evaluate it. Throwing, returning an
 * unknown value, or returning undefined preserves the descriptor's risk.
 *
 * In core rather than in the guard because the guard is not its only reader:
 * the automations engine grades a DECLARED call at arm time with the same
 * resolver, so the consent card shows the grade the call will really run under
 * and the grant it mints carries the descriptor hash the guard will compute. */
export type RiskResolver = (
  call: ToolCall,
  descriptor: ToolDescriptor,
  ctx: RunContext,
) => RiskLabel | undefined | Promise<RiskLabel | undefined>;

/** The descriptor a {@link RiskResolver}'s answer produces. Unchanged when the
 *  resolver declined or agreed, so `descriptorHash` stays stable for every tool
 *  whose grade is authored — and identical on both sides for the one whose
 *  grade is not, which is what keeps a minted grant matchable. */
export function withResolvedRisk(descriptor: ToolDescriptor, resolved: unknown): ToolDescriptor {
  const parsed = riskLabelSchema.safeParse(resolved);
  if (!parsed.success) return descriptor;
  return parsed.data === descriptor.risk ? descriptor : { ...descriptor, risk: parsed.data };
}

/** 01-core §4 — a connector call that needs a per-user connected account first
 * (04-actions §3). `connector`/`toolkit` key the umbrella's /connections
 * endpoints; the UI renders an inline connect card and retries after connecting. */
export interface ConnectRequired {
  connector: string;
  toolkit: string;
  message: string;
}

/** 01-core §4 */
const connectRequiredSchema = z.object({
  connector: z.string().min(1),
  toolkit: z.string().min(1),
  message: z.string(),
}).passthrough() satisfies z.ZodType<ConnectRequired>;

/** 01-core §4 */
export type ToolOutcome =
  | { status: "ok"; output: Json }
  | { status: "error"; error: { code: string; message: string } }
  | { status: "pending-approval"; approvalId: ApprovalId }
  | { status: "blocked"; reason: string }
  | { status: "connect-required"; connect: ConnectRequired };

/** 01-core §4 */
export const toolOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), output: requiredJsonValueSchema }).passthrough(),
  z.object({
    status: z.literal("error"),
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  }).passthrough(),
  z.object({ status: z.literal("pending-approval"), approvalId: approvalIdSchema }).passthrough(),
  z.object({ status: z.literal("blocked"), reason: z.string() }).passthrough(),
  z.object({ status: z.literal("connect-required"), connect: connectRequiredSchema }).passthrough(),
]) satisfies z.ZodType<ToolOutcome>;

/** The run a listing is asked FOR (01-core §4) — a `RunContext` is one.
 *
 *  `venue`/`presence` are what design §12's projection reads: the guard
 *  withholds destructive and external tools from an unattended run.
 *  `grantedServiceSlugs` is the one thing that can put a withheld tool BACK on an
 *  unattended listing — the connector dispatcher, for a firing that holds a live
 *  per-slug grant — and it widens nothing else. Nothing else narrows a listing:
 *  every tool a run may call is on every listing that run is given, so a listing
 *  never has to be identified. */
export type ToolListingContext = Pick<RunContext, "venue" | "presence" | "grantedServiceSlugs">;

/** 01-core §4 */
export interface ToolRegistry {
  /** The tools available. Passing a run's context asks for the set that may be
   *  PROJECTED into that run — see {@link ToolListingContext}.
   *
   *  Optional so every existing registry stays a valid implementation: a
   *  zero-parameter `descriptors()` is assignable here and simply ignores the
   *  hint, which means only the guard-bound registry has to know the law. */
  descriptors(ctx?: ToolListingContext): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}
