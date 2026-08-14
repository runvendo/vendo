/**
 * The closed list of `createVendo` top-level keys, and where each one is going.
 *
 * WHY THIS IS A SOURCE FILE AND NOT A TEST FIXTURE. The docs-rot gate used to
 * pin the same list inside `handler-options.docs.test.ts`, with an `AssertNever`
 * meant to fail compilation if the interface grew a key the list did not have.
 * It never ran: `packages/vendo/tsconfig.json` excludes `src/**\/*.test.ts` from
 * typecheck, so the assertion was compiled by nothing and the list silently
 * drifted ten keys behind the interface. Living here it is inside the typecheck
 * include, so the compile-time half of the gate is real.
 *
 * Three checks hang off this one list, and each can fail on its own:
 *   1. typecheck — the list and `keyof CreateVendoConfig` are asserted equal in
 *      BOTH directions below;
 *   2. `handler-options.docs.test.ts` — the docs-site composition table lists
 *      exactly these keys;
 *   3. the same test — the §10 migration table states a destination for each.
 *
 * It also does real work at runtime: {@link warnDeprecatedConfigKeys} is what
 * tells a host on the old shape where the key went.
 */
import { VendoError } from "@vendoai/core";
import type { CreateVendoConfig } from "./types.js";

/**
 * Every top-level key of {@link CreateVendoConfig}, in declaration order.
 *
 * Adding a key to the interface without adding it here is a typecheck failure
 * (`_NoMissingKeys` below); adding one here that does not exist is also a
 * typecheck failure (`_listedKeysExist`).
 */
export const CREATE_VENDO_CONFIG_KEYS = [
  "model",
  "paint",
  "models",
  "auth",
  "principal",
  "tools",
  "skills",
  "catalog",
  "theme",
  "instructions",
  "store",
  "files",
  "sandbox",
  "harness",
  "knowledge",
  "connectors",
  "connections",
  "actAs",
  "serverActions",
  "guard",
  "secrets",
  "logger",
  "telemetry",
  "development",
  "profileDir",
  "fetch",
  "profile",
  "mcp",
  "oauth",
  "agent",
  "sweep",
  "toolOutputCap",
  "maxInitialTools",
  "loadout",
  "apps",
  "automations",
  "channels",
] as const;

export type CreateVendoConfigKey = (typeof CREATE_VENDO_CONFIG_KEYS)[number];

// …every listed key exists on the interface…
const _listedKeysExist: ReadonlyArray<keyof CreateVendoConfig> = CREATE_VENDO_CONFIG_KEYS;
void _listedKeysExist;
// …and every interface key is listed (this resolves to `never`, or it fails).
type AssertNever<T extends never> = T;
type _NoMissingKeys = AssertNever<Exclude<keyof CreateVendoConfig, CreateVendoConfigKey>>;

/**
 * Keys that still work and should not be used, mapped to the sentence a host is
 * told. One minor of grace (the `model`/`paint` precedent), then they go.
 *
 * Spelled with the nested path where the deprecation is nested — `profile.tools`
 * is deprecated, `profile` itself is not.
 */
export const DEPRECATED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  model: "`model` is deprecated: use the `models.default` seat — `models: { default: … }`. It still works for one more minor.",
  paint: "`paint` is deprecated: use the `models.fill` seat — `models: { fill: … }`. It still works for one more minor.",
  "profile.tools":
    "`profile.tools` is deprecated: use the `tools:` slot, which is the same in-memory host-tool "
    + "declarations under their §10 name. It still works for one more minor.",
};

/**
 * Keys that are GONE, mapped to the sentence naming their replacement.
 *
 * Unlike {@link DEPRECATED_CONFIG_KEYS} these do not work at all, so the
 * response is a boot error rather than a warning. TypeScript already rejects
 * every one of them; this is for the JavaScript host, where a dropped `policy`
 * would mean an unconfigured guard running wide open and a dropped `brief`
 * would mean an agent that forgot what the product is. A config change must
 * never fail that way quietly.
 */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  brief: "`brief` is gone: use `instructions` — one prose key, the same `.vendo/brief.md` surface behind it.",
  policy: "`policy` is gone: use `guard: guard({ policy })` from @vendoai/vendo/server.",
  judge: "`judge` is gone: use `guard: guard({ judge })` from @vendoai/vendo/server.",
  approvals: "`approvals` is gone: use `guard: guard({ approvals })` from @vendoai/vendo/server.",
  connectorApps:
    "`connectorApps` is gone: name the toolkits in `connectors` itself — `connectors: [\"gmail\", \"slack\"]` "
    + "(strings and connector objects are one list now).",
};

/** The `agent:` grab-bag members, and where each one went. Reported together
 *  when a host still passes the options object, because a config on the old
 *  shape usually carries several of them. */
export const REMOVED_AGENT_OPTION_KEYS: Readonly<Record<string, string>> = {
  instructions: "the top-level `instructions` key",
  toolOutputCap: "the top-level `toolOutputCap` key",
  maxInitialTools: "the top-level `maxInitialTools` key",
  loadout: "the top-level `loadout` key",
  maxSteps: "`harness: vendo({ maxSteps })`",
  historyWindow: "`harness: vendo({ historyWindow })`",
  maxOutputTokens: "`harness: vendo({ maxOutputTokens })`",
};

/**
 * Refuse a config still written against a removed key, naming the replacement.
 * Called from `createVendo` before anything is constructed.
 */
export function rejectRemovedConfigKeys(config: Partial<Record<string, unknown>>): void {
  for (const [key, message] of Object.entries(REMOVED_CONFIG_KEYS)) {
    if (config[key] !== undefined) throw new VendoError("validation", message);
  }
  // `agent:` survives as the composed-agent slot, so it is the VALUE that says
  // whether this is the old knobs object: an agent from `agent()` has a
  // `session`, and the knobs object never did.
  const agent = config["agent"] as Record<string, unknown> | undefined;
  if (agent === undefined || typeof agent["session"] === "function") return;
  const moved = Object.keys(REMOVED_AGENT_OPTION_KEYS)
    .filter((key) => agent[key] !== undefined)
    .map((key) => `\`agent.${key}\` → ${REMOVED_AGENT_OPTION_KEYS[key]}`);
  throw new VendoError(
    "validation",
    "`agent:` now takes only a whole agent built by `agent()` from @vendoai/agents. "
    + (moved.length === 0
      ? "The chat-knobs object is gone."
      : `Move ${moved.join(", ")}.`),
  );
}

/** Keys already warned about in THIS process. A deployment composes once, but a
 *  test file or a multi-tenant venue composes many times, and repeating the same
 *  advice per composition is noise nobody reads. */
const warned = new Set<string>();

/** Test seam: the warn-once set is process-lifetime, so a suite that asserts the
 *  warning has to be able to clear it. Never called by composition. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}

/**
 * Say, once per key per process, that a set key has moved. Called from
 * `createVendo` with the raw config — the shims themselves live where the value
 * is read (`resolveModels` for the model pair, `selectHostTools` for the tools
 * slot), because that is where the precedence lives.
 */
export function warnDeprecatedConfigKeys(
  config: Partial<Record<string, unknown>> & { profile?: Record<string, unknown> },
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  for (const [key, message] of Object.entries(DEPRECATED_CONFIG_KEYS)) {
    const [head, nested] = key.split(".");
    const value = nested === undefined
      ? config[head as string]
      : (config[head as string] as Record<string, unknown> | undefined)?.[nested];
    if (value === undefined || warned.has(key)) continue;
    warned.add(key);
    warn(`[vendo] ${message}`);
  }
}

/**
 * The keys a markdown table documents: the first cell of every row whose first
 * cell is a single backticked identifier (`| \`store\` | … |`).
 *
 * Shared by both docs gates rather than re-derived per test, so "the docs list
 * these keys" means the same thing on the reference page and in the migration
 * table.
 */
export function tableKeys(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|/gm)].map((match) => match[1] as string);
}

/** What a documented key set is missing, and what it invented. Returned rather
 *  than asserted so the gate's own red-green test can drive it with a synthetic
 *  page instead of corrupting a real one. */
export function docsTableDiff(
  documented: readonly string[],
  expected: readonly string[] = CREATE_VENDO_CONFIG_KEYS,
): { missing: string[]; unknown: string[]; duplicated: string[] } {
  const seen = new Set<string>();
  const duplicated = documented.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
  return {
    missing: expected.filter((key) => !seen.has(key)),
    unknown: [...seen].filter((key) => !expected.includes(key as CreateVendoConfigKey)),
    duplicated: [...new Set(duplicated)],
  };
}
