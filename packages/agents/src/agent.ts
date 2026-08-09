/**
 * The front door. Assemble, validate, return — a Vendo Cloud key fills every
 * slot left unset (adapter rule, no second code paths), an explicit adapter
 * always wins, and every failure is a boot error with a way out.
 */
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { e2bSandbox } from "@vendoai/apps/e2b";
import { selectSandbox } from "@vendoai/apps/sandbox-ladder";
import {
  VendoError,
  type FilesAdapter,
  type Harness,
  type Skill,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard, isGuardInstance, type GuardRules, type VendoGuard } from "@vendoai/guard";
import { provideHarnessAdapters } from "@vendoai/harnesses";
import { createStore, storeFiles, type VendoStore } from "@vendoai/store";
import { randomUUID } from "node:crypto";
import { resolveDoor, type DoorConfig } from "./door.js";
import { withEgress, type EgressConfig } from "./egress.js";
import type { SystemPromptHook } from "./prompt.js";
import { createSession, type AgentSession, type SessionDeps, type SessionOptions } from "./session.js";
import { mergeSources, type McpServerConfig, type ToolSource } from "./tools.js";
import { loadSkillFolders } from "./skills.js";

export interface AgentConfig {
  /** Audit and inbox attribution. */
  name: string;
  /** The brain; its knobs (model, effort, machine, template) bind at construction. */
  harness: Harness<unknown>;
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
  session(subject: string, options?: SessionOptions): Promise<AgentSession>;
  /**
   * This agent's MCP door, present exactly when its harness thinks outside this
   * process (`requires.toolDoor`). A library cannot add a route to the host's
   * server, so MOUNT THIS at `DOOR_PATH` (`/api/vendo/mcp`) — it is where the
   * box dials back to reach your tools, and it answers nothing but a live
   * turn's own credential.
   */
  readonly door?: (request: Request) => Promise<Response>;
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
 * The Cloud rungs. Their concrete shapes live with the Cloud wiring (the
 * tenant-store access design is under review, 2026-08-04 hold), so this
 * package holds only the seam: an interface that returns a store/adapter.
 * `createVendo` (or the host) fills it; unfilled, the rung is a clear error.
 */
export interface CloudAdapters {
  store?: (key: { apiKey: string; baseUrl?: string }) => VendoStore;
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
  if (key !== undefined) {
    if (cloudAdapters.store === undefined) {
      throw new VendoError(
        "not-implemented",
        "A VENDO_API_KEY is set but this build has no Cloud store rung wired (tenant-store access is "
        + "under redesign). Pass `store: postgres(url)` explicitly, or unset the key for the embedded store.",
      );
    }
    return cloudAdapters.store(key);
  }
  return createStore();
};

/** The ladder itself lives in @vendoai/apps (`selectSandbox`) — ONE
 *  implementation, shared with the umbrella's composition seam. This function
 *  is only what an EMPTY ladder means here: a harness that needs a machine and
 *  has none is a boot error, not a turn that dies in front of a user. */
const resolveSandbox = (explicit: SandboxAdapter | undefined): SandboxAdapter => {
  const { adapter } = selectSandbox(explicit, cloudAdapters.sandbox);
  if (adapter !== undefined) return adapter;
  if (cloudKey() !== undefined) {
    throw new VendoError(
      "not-implemented",
      "A VENDO_API_KEY is set but this build has no Cloud sandbox rung wired. "
      + "Pass `sandbox: e2b({ apiKey })` or set E2B_API_KEY.",
    );
  }
  throw new VendoError(
    "validation",
    "This harness runs on a sandbox and none resolved: pass `sandbox: e2b({ apiKey })`, "
    + "set E2B_API_KEY, or set VENDO_API_KEY for the Cloud pool.",
  );
};

export function agent(config: AgentConfig): VendoAgent {
  if (config.name === undefined || config.name.trim() === "") {
    throw new VendoError("validation", "agent({ name }) is required — it attributes audit rows and the inbox.");
  }
  if (config.harness === undefined) {
    throw new VendoError("validation", "agent({ harness }) is required — e.g. claudeCode({ model }).");
  }

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
    config.harness.requires?.sandbox === true ? resolveSandbox(config.sandbox) : config.sandbox;
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
  const door = config.harness.requires?.toolDoor === true
    ? resolveDoor(
      config.door,
      { name: config.harness.name, sandboxed: config.harness.requires?.sandbox === true },
      { tools: bound, guard, store },
    )
    : undefined;
  provideHarnessAdapters(config.harness, {
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(door === undefined ? {} : { toolDoor: door.port }),
  });
  const liveTurn: SessionDeps["liveTurn"] = door === undefined
    ? undefined
    : ({ threadId, ctx, tools }) => door.publish(threadId, { ctx, tools });

  const deps = {
    name: config.name,
    harness: config.harness,
    store,
    files,
    guard,
    tools: bound,
    skills,
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
    session: (subject, options) => createSession(deps, subject, options),
    ...(door === undefined ? {} : { door: door.handler }),
  };
  compositions.set(built, { ...deps, ...(sandbox === undefined ? {} : { sandbox }) });
  return built;
}
