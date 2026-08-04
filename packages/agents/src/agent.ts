/**
 * The front door. Assemble, validate, return — a Vendo Cloud key fills every
 * slot left unset (adapter rule, no second code paths), an explicit adapter
 * always wins, and every failure is a boot error with a way out.
 */
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { e2bSandbox } from "@vendoai/apps/e2b";
import {
  VendoError,
  type FilesAdapter,
  type Harness,
  type PackSkill,
} from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { provideHarnessAdapters } from "@vendoai/harnesses";
import { createStore, storeFiles, type VendoStore } from "@vendoai/store";
import { randomUUID } from "node:crypto";
import { withEgress, type EgressConfig } from "./egress.js";
import type { McpServerConfig } from "./mcp.js";
import { createSession, type AgentSession, type SessionOptions } from "./session.js";
import { mergeSources, type ToolSource } from "./tools.js";
import { loadSkillFolders } from "./skills.js";

export interface AgentConfig {
  /** Audit and inbox attribution. */
  name: string;
  /** The brain; its knobs (model, effort, machine, template) bind at construction. */
  harness: Harness<unknown>;
  tools?: readonly ToolSource[];
  mcp?: readonly McpServerConfig[];
  /** Always an instance; unset → default `createGuard({ store })`. */
  guard?: VendoGuard;
  /** Skill folders, boot-loaded; deploy = update the folder. */
  skills?: readonly string[];
  /** Agent-level outbound allowlist; unset = the harness's minimum. */
  egress?: EgressConfig;
  /** Unset + `VENDO_API_KEY` → Cloud tenant Postgres; unset alone → embedded. */
  store?: VendoStore;
  /** Unset + key → the ladder (E2B key, Cloud pool). */
  sandbox?: SandboxAdapter;
  /** The host's prompt block. */
  instructions?: string;
}

export interface VendoAgent {
  readonly name: string;
  session(subject: string, options?: SessionOptions): Promise<AgentSession>;
}

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
 *  `postgres(url, { blobs: s3({...}) })` stays one value in one slot. */
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

const resolveSandbox = (explicit: SandboxAdapter | undefined): SandboxAdapter => {
  if (explicit !== undefined) return explicit;
  const e2bKey = process.env["E2B_API_KEY"];
  if (e2bKey !== undefined && e2bKey !== "") return e2bSandbox({ apiKey: e2bKey });
  const key = cloudKey();
  if (key !== undefined) {
    if (cloudAdapters.sandbox === undefined) {
      throw new VendoError(
        "not-implemented",
        "A VENDO_API_KEY is set but this build has no Cloud sandbox rung wired. "
        + "Pass `sandbox: e2b({ apiKey })` or set E2B_API_KEY.",
      );
    }
    return cloudAdapters.sandbox(key);
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
  const guard = config.guard ?? createGuard({ store });
  const tools = mergeSources(config.tools ?? [], config.mcp ?? []);
  const bound = guard.bind(tools);
  const skills: PackSkill[] = loadSkillFolders(config.skills);

  const sandbox =
    config.harness.requires?.sandbox === true ? resolveSandbox(config.sandbox) : config.sandbox;
  if (sandbox !== undefined) {
    // One audit row per box boot: which egress skin this box was born with —
    // written before the box exists, attributed to the agent itself.
    const audited = withEgress(sandbox, config.egress, (domains) =>
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
    provideHarnessAdapters(config.harness, { sandbox: audited });
  }

  const deps = {
    name: config.name,
    harness: config.harness,
    store,
    files,
    guard,
    tools: bound,
    skills,
    ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
  };

  return {
    name: config.name,
    session: (subject, options) => createSession(deps, subject, options),
  };
}
