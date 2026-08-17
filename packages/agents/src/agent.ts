/**
 * The front door. Assemble, validate, return — a Vendo Cloud key fills every
 * slot left unset (adapter rule, no second code paths), an explicit adapter
 * always wins, and every failure is a boot error with a way out.
 */
import {
  HOT_PATH_WATCH,
  hotPathAppId,
  repairInstruction,
  validateWrittenApps,
  type SandboxAdapter,
  type SandboxMachine,
  e2bSandbox,
  selectSandbox,
} from "@vendoai/apps";
import {
  VendoError,
  type FilesAdapter,
  type Harness,
  type SeatModels,
  type Skill,
  type ToolRegistry,
  type When,
} from "@vendoai/core";
import { createGuard, isGuardInstance, permissionsHandler, type GuardRules, type VendoGuard } from "@vendoai/guard";
import { provideHarnessAdapters, vendo } from "@vendoai/harnesses";
import { vendoModel } from "@vendoai/harnesses/inference";
import { resolveDevCredential } from "@vendoai/harnesses/inference/credential";
import { createStore, hostedStore, storeFiles, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { declareAutomation, type OnOptions } from "./automations.js";
import { startRun, type AgentRun, type RunOptions } from "./away.js";
import { resolveDoor, type DoorConfig } from "./door.js";
import { withEgress, type EgressConfig } from "./egress.js";
import { PERMISSIONS_PATH, schemaReadyPrincipal, type AgentPrincipal } from "./permissions.js";
import type { SystemPromptHook } from "./prompt.js";
import {
  createSession,
  type AgentSession,
  type RespondOptions,
  type SessionDeps,
  type SessionOptions,
} from "./session.js";
import { mergeSources, type McpServerConfig, type ToolSource } from "./tools.js";
import { loadSkillFolders } from "./skills.js";

export interface AgentConfig {
  /** Audit and inbox attribution. */
  name: string;
  /** The brain; its knobs (effort, machine, template) bind at construction.
   *  Unset → `vendo()`, the in-process default. */
  harness?: Harness<unknown>;
  /** What `vendo()` thinks with (the `default` seat). A harness that brings its
   *  own brain — `claudeCode()` — ignores it. */
  model?: LanguageModel;
  tools?: readonly ToolSource[];
  mcp?: readonly McpServerConfig[];
  /** A built guard, or the rules for one — `guard({ policy, judge, approvals })`,
   *  which this composition completes with its own store. An instance always
   *  wins verbatim; unset → default `createGuard({ store })`. */
  guard?: VendoGuard | GuardRules;
  /** Skill folders, boot-loaded; deploy = update the folder. */
  skills?: readonly string[];
  /** Agent-level outbound allowlist; unset = the harness's minimum. */
  egress?: EgressConfig;
  /** Unset + `VENDO_API_KEY` → Cloud tenant Postgres; unset alone → embedded. */
  store?: VendoStore;
  /** Unset + key → the ladder (E2B key, Cloud pool). */
  sandbox?: SandboxAdapter;
  /** Where a thinker that runs outside this process dials back to reach your
   *  tools; unset → `VENDO_BASE_URL`. Required by any harness that declares
   *  `requires.toolDoor` — see {@link resolveDoor}. */
  door?: DoorConfig;
  /** Who is asking, for {@link VendoAgent.permissions}. Unset → those routes
   *  401: a person's own asks and grants need a person. */
  principal?: AgentPrincipal;
  /** The host's prompt block. */
  instructions?: string;
  /**
   * The last word on the per-turn system prompt. Called once per turn with the
   * ctx and this package's own assembly; a returned string is used VERBATIM
   * (even `""`), `undefined` means the default assembly.
   *
   * ONE hook, both venues — `ctx.venue` says which — so a chat turn and an away
   * firing cannot drift into two agents wearing one name. `undefined` meaning
   * "the default" is what keeps a conditional that falls through from silently
   * stripping the rules; replacing wholesale hands the base rules and the
   * forgery-safe `[User]`/`[Situation]` blocks to the host, to keep or to drop.
   */
  system?: SystemPromptHook;
}

export interface VendoAgent {
  readonly name: string;
  /**
   * ONE lane per shape of caller. `respond` answers a person: one turn, an
   * AI-SDK UI-message-stream `Response` to return from your route, with the
   * conversation's id on `x-vendo-thread-id`. `run` answers code: no screen, a
   * report at the end.
   *
   * It is exactly `session(subject, options)` followed by `stream(message)` —
   * reach for `session()` when you want the object (approval events, several
   * turns on one thread), and this when you want the Response.
   */
  respond(subject: string, message: string | UIMessage, options?: RespondOptions): Promise<Response>;
  /** One unattended run: no screen, an {@link AgentRun} whose report says what
   *  happened. Venue "automation", presence "away", non-interactive — so a tool
   *  the guard wants a person for parks, and `refs.approvals` is who to ask. */
  run<T = never>(task: string, options?: RunOptions<T>): AgentRun<T>;
  /**
   * Declare an automation this agent runs unattended. A bare string is a cron
   * expression; the other four shapes are `{ every }`, `{ at }`, `{ event }` and
   * `{ webhook }`.
   *
   *     support.on("0 9 * * 1", "summarize the week and email ops");
   *     support.on({ every: "1d" }, "refresh credit scores");
   *     support.on({ event: "payment.failed" }, "triage and notify the user");
   *     support.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
   *
   * Returns void because it is a DECLARATION: it is validated here and now — a
   * bad cron throws at module load, with what, why, a did-you-mean and the docs
   * — and reconciled against the store when `createVendo` boots. The code is the
   * consent, so deleting the call disarms the automation on the next deploy;
   * `disable()` by a person outlives every redeploy.
   */
  on(when: When, task: string, options?: OnOptions): void;
  session(subject: string, options?: SessionOptions): Promise<AgentSession>;
  /**
   * This agent's MCP door, present exactly when its harness thinks outside this
   * process (`requires.toolDoor`). A library cannot add a route to the host's
   * server, so MOUNT THIS at `DOOR_PATH` (`/api/vendo/mcp`) — it is where the
   * box dials back to reach your tools, and it answers nothing but a live
   * turn's own credential.
   */
  readonly door?: (request: Request) => Promise<Response>;
  /**
   * This agent's approvals and grants wire — what `@vendoai/ui`'s consent
   * surfaces already post to. MOUNT THIS at `PERMISSIONS_PATH`
   * (`/api/vendo`); `undefined` comes back for every path it does not own,
   * `DOOR_PATH` included, so ONE catch-all route can serve both.
   */
  readonly permissions: (request: Request) => Promise<Response | undefined>;
}

/**
 * What `agent()` composed, for the one consumer that composes AROUND it:
 * `createVendo({ agent })`, where the embed adopts the agent's brain, its
 * persistence and its venue instead of resolving a second set. Read through a
 * WeakMap — the same shape `harnessAdapters()` uses — so the public agent
 * object stays exactly `{ name, session }`.
 */
export interface AgentComposition {
  harness: Harness<unknown>;
  store: VendoStore;
  files: FilesAdapter;
  guard: VendoGuard;
  /** Guard-bound already — the one choke point. */
  tools: ToolRegistry;
  skills: readonly Skill[];
  /** Present only for a harness that thinks on a machine. */
  sandbox?: SandboxAdapter;
  /** The seats a harness that does NOT bring its own brain reads (`vendo()`). */
  models?: SeatModels<LanguageModel>;
  instructions?: string;
  /** Carried so `awayRunner(agentComposition(agent))` speaks in the same voice
   *  the agent's own turns do. */
  system?: SystemPromptHook;
}

const compositions = new WeakMap<VendoAgent, AgentComposition>();

/** Undefined for anything this package did not build. */
export const agentComposition = (agent: VendoAgent): AgentComposition | undefined =>
  compositions.get(agent);

/**
 * The Cloud rungs. Their concrete shapes ship with the Cloud wiring, so this
 * package holds only the seam: an interface that returns a store/adapter.
 * `createVendo` (or the host) fills it; unfilled, the rung is a clear error.
 */
export interface CloudAdapters {
  sandbox?: (key: { apiKey: string; baseUrl?: string }) => SandboxAdapter;
}
let cloudAdapters: CloudAdapters = {};
export function provideCloudAdapters(adapters: CloudAdapters): void {
  cloudAdapters = { ...cloudAdapters, ...adapters };
}

const cloudKey = (): { apiKey: string; baseUrl?: string } | undefined => {
  const apiKey = process.env["VENDO_API_KEY"];
  if (apiKey === undefined || apiKey === "") return undefined;
  const baseUrl = process.env["VENDO_CLOUD_URL"];
  return { apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) };
};

/** Blob adapters ride beside the store they were configured with, so
 *  `postgres(url, { blobs: myFilesAdapter })` stays one value in one slot. */
const storeBlobs = new WeakMap<VendoStore, FilesAdapter>();

export interface PostgresOptions {
  /** Where workspace blobs land; unset → the store's own rows (≤ 5 MiB each). */
  blobs?: FilesAdapter;
  encryption?: { key: string };
  allowUnencryptedSecrets?: boolean;
}

export function postgres(url: string, options: PostgresOptions = {}): VendoStore {
  if (url === undefined || url === "") {
    throw new VendoError("validation", "postgres(url) needs a connection string.");
  }
  const store = createStore({
    url,
    ...(options.encryption === undefined ? {} : { encryption: options.encryption }),
    ...(options.allowUnencryptedSecrets === undefined
      ? {}
      : { allowUnencryptedSecrets: options.allowUnencryptedSecrets }),
  });
  if (options.blobs !== undefined) storeBlobs.set(store, options.blobs);
  return store;
}

export interface E2bOptions {
  apiKey?: string;
  /** Default box template when the harness names none. */
  template?: string;
  timeoutMs?: number;
}

/** The harness's own template always wins; the adapter's is the fallback. */
export const withDefaultTemplate = (adapter: SandboxAdapter, template: string): SandboxAdapter => ({
  ...adapter,
  create: (spec: Parameters<SandboxAdapter["create"]>[0]): Promise<SandboxMachine> =>
    adapter.create({ ...spec, template: spec.template ?? template }),
});

export function e2b(options: E2bOptions = {}): SandboxAdapter {
  const adapter = e2bSandbox({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return options.template === undefined ? adapter : withDefaultTemplate(adapter, options.template);
}

const defaultStore = (): VendoStore => {
  const key = cloudKey();
  return key === undefined ? createStore() : hostedStore(key);
};

/** The ladder itself lives in @vendoai/apps (`selectSandbox`) — ONE
 *  implementation, shared with the umbrella's composition seam. This function
 *  is only what an EMPTY ladder means here: a harness that needs a machine and
 *  has none is a boot error, not a turn that dies in front of a user. Both
 *  messages name the two ways out in the same order the law states them:
 *  explicit config first, then VENDO_API_KEY. */
const resolveSandbox = (explicit: SandboxAdapter | undefined): SandboxAdapter => {
  const { adapter } = selectSandbox(explicit, cloudAdapters.sandbox);
  if (adapter !== undefined) return adapter;
  if (cloudKey() !== undefined) {
    throw new VendoError(
      "not-implemented",
      "A VENDO_API_KEY is set but this build has no Cloud sandbox rung wired. "
      + "Pass a sandbox explicitly — `sandbox: e2b()`, which reads E2B_API_KEY as its credential "
      + "(import `e2b` from `@vendoai/agents`) — or use a build that ships the Cloud sandbox rung "
      + "for VENDO_API_KEY to fill.",
    );
  }
  throw new VendoError(
    "validation",
    "This harness runs on a sandbox and none resolved: pass one — `sandbox: e2b()`, which reads "
    + "E2B_API_KEY as its credential (import `e2b` from `@vendoai/agents`) — or set VENDO_API_KEY "
    + "for the Vendo Cloud sandbox pool. "
    + "An E2B_API_KEY alone no longer selects a sandbox.",
  );
};

export function agent(config: AgentConfig): VendoAgent {
  if (config.name === undefined || config.name.trim() === "") {
    throw new VendoError("validation", "agent({ name }) is required — it attributes audit rows and the inbox.");
  }
  // The same default the umbrella takes (`packages/vendo/src/compose-harness.ts`):
  // one thinker, named in one place, so `agent({ name, tools })` is a whole agent.
  const harness = config.harness ?? vendo();
  // ONE seat, one ladder: an explicit `model` is used verbatim, always; unset,
  // `vendoModel()` is the zero-key rung (`vendo login` / VENDO_API_KEY). The
  // ladder is `@vendoai/harnesses`'s — this package holds no rung of its own.
  const models = { default: config.model ?? vendoModel() };
  /**
   * `vendo()` thinks with the `default` seat, so a turn with neither an explicit
   * model nor a rung under `vendoModel()` cannot happen — and the ladder's own
   * keyless message names `createVendo`, which is not the surface this host is
   * holding. Asked at the first turn rather than at boot: the detector is async
   * (`resolveDevCredential`), and a host that names its own harness owns saying
   * which seats it reads (`packages/core/src/model-seats.ts`).
   */
  const requireModel = async (): Promise<void> => {
    if (config.harness !== undefined || config.model !== undefined) return;
    if ((await resolveDevCredential()).rung !== "none") return;
    throw new VendoError(
      "validation",
      "agent({ model }) is required — vendo(), the default brain, thinks with it. Pass one — "
      + "`model: anthropic(\"claude-sonnet-4-6\")`, importing `anthropic` from `@ai-sdk/anthropic` "
      + "— or name a harness that brings its own, e.g. `harness: claudeCode()`, importing "
      + "`claudeCode` from `@vendoai/harnesses/claude-code`.",
    );
  };

  const store = config.store ?? defaultStore();
  const files = storeBlobs.get(store) ?? storeFiles(store);
  // One constructor either way: an instance is taken verbatim, rules are
  // completed with this composition's store.
  const guard = isGuardInstance(config.guard)
    ? config.guard
    : createGuard({ store, ...config.guard });
  const tools = mergeSources(config.tools ?? [], config.mcp ?? []);
  const bound = guard.bind(tools);
  const skills: Skill[] = loadSkillFolders(config.skills);

  const resolved =
    harness.requires?.sandbox === true ? resolveSandbox(config.sandbox) : config.sandbox;
  // One audit row per box boot: which egress skin this box was born with —
  // written before the box exists, attributed to the agent itself. Every
  // consumer takes the AUDITED adapter, so a box booted by the embed carries
  // the same skin and the same row as one booted by `session.stream`.
  const sandbox = resolved === undefined ? undefined : withEgress(resolved, config.egress, (domains) =>
    guard.report({
      id: `aud_${randomUUID()}`,
      at: new Date().toISOString(),
      kind: "policy-decision",
      principal: { kind: "user", subject: `vendo:agent:${config.name}` },
      venue: "chat",
      presence: "away",
      detail: { egress: domains === "all" ? "all" : [...domains] },
    }),
  );
  // A harness that thinks outside this process gets a REAL door or no boot.
  // Both legs of `claudeCode()` declare it — a box and a local subprocess reach
  // the host's tools over the same remote MCP — so this runs whether or not a
  // sandbox resolved above.
  const door = harness.requires?.toolDoor === true
    ? resolveDoor(
      config.door,
      { name: harness.name, sandboxed: harness.requires?.sandbox === true },
      { tools: bound, guard, store },
    )
    : undefined;
  provideHarnessAdapters(harness, {
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(door === undefined ? {} : { toolDoor: door.port }),
    // The app-document vocabulary a machine-backed driver needs (the hot-path
    // watch set and the validate gate) — injected because `@vendoai/harnesses`
    // no longer imports `@vendoai/apps`. Same fill as the umbrella's
    // (`packages/vendo/src/harness-turn.ts`), so both composed paths stay
    // byte-identical to when the driver imported these itself.
    hotPaths: { watch: HOT_PATH_WATCH, appId: hotPathAppId },
    validateApps: validateWrittenApps,
    repairInstruction,
  });
  const liveTurn: SessionDeps["liveTurn"] = door === undefined
    ? undefined
    : ({ threadId, ctx, tools }) => door.publish(threadId, { ctx, tools });

  const deps = {
    name: config.name,
    harness,
    store,
    files,
    guard,
    tools: bound,
    skills,
    models,
    assertModel: requireModel,
    ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
    ...(config.system === undefined ? {} : { system: config.system }),
    // The other half of the door: a credential the harness minted resolves to
    // NOTHING until the turn it points at is published, so without this line a
    // mounted door 401s every tool call the box makes.
    ...(liveTurn === undefined ? {} : { liveTurn }),
    ...(door?.ready === undefined ? {} : { doorReady: door.ready }),
  };

  const built: VendoAgent = {
    name: config.name,
    async respond(subject, message, options = {}) {
      await requireModel();
      const session = await createSession(deps, subject, options);
      // `respond` IS `session` + `stream`, and the id lands on the Response the
      // way `session.stream` already stamps it — one code path, one header.
      return session.stream(message, options.signal === undefined ? {} : { signal: options.signal });
    },
    run: (task, options) => startRun(deps, task, options),
    on: (when, task, options) => declareAutomation(built, when, task, options),
    async session(subject, options) {
      await requireModel();
      return createSession(deps, subject, options);
    },
    // No principal resolver is not "everyone": these routes hand a person their
    // own pending asks and standing grants, so with nobody to identify they 401.
    permissions: permissionsHandler({
      guard,
      principal: schemaReadyPrincipal(config.principal ?? (async () => null), store),
      mount: PERMISSIONS_PATH,
    }),
    ...(door === undefined ? {} : { door: door.handler }),
  };
  compositions.set(built, { ...deps, ...(sandbox === undefined ? {} : { sandbox }) });
  return built;
}
