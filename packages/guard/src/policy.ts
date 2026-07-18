import { VendoError } from "@vendoai/core";
import type { PolicyConfig, PolicyConfigObject, PolicyFile, PolicyPresetName, PolicyRule } from "./types.js";
import { policyFileSchema } from "./types.js";

const DEFAULT_POLICY_FILE = ".vendo/policy.json";

/** Design decision 8 (00-overview): named presets are pure sugar, expanded to
 *  rules before evaluation. "autopilot" uses an explicit catch-all `run` rule
 *  rather than an empty rule set: an autopilot call is decided by that rule
 *  (`decidedBy: "rule"`), not by the guard's no-match "default" fallthrough —
 *  the audit trail should show autopilot was a deliberate choice, not an
 *  absence of policy. Both expansions already read as "configured" for
 *  `status()` (it only checks whether a resolved policy object exists at
 *  all), so this is about audit-trail honesty, not the unconfigured/rules
 *  distinction. */
const POLICY_PRESET_RULES: Record<PolicyPresetName, PolicyRule[]> = {
  cautious: [
    { match: { risk: "destructive" }, action: "ask" },
    { match: { risk: "write" }, action: "ask" },
    { match: { risk: "read" }, action: "run" },
  ],
  readonly: [
    { match: { risk: "read" }, action: "run" },
    { match: { risk: "write" }, action: "block" },
    { match: { risk: "destructive" }, action: "block" },
  ],
  autopilot: [{ match: {}, action: "run" }],
};

const POLICY_PRESET_NAMES = Object.keys(POLICY_PRESET_RULES) as PolicyPresetName[];

function isPolicyPresetName(value: string): value is PolicyPresetName {
  return Object.hasOwn(POLICY_PRESET_RULES, value);
}

/** Expands a named preset string to its rules, or passes an object-form
 *  config through unchanged. Resolves synchronously — compose time, not
 *  first call — so an unknown preset name fails loud from `createGuard`
 *  itself rather than surprising the first `guard.check()`. */
export function resolvePolicyConfig(config: PolicyConfig | undefined): PolicyConfigObject | undefined {
  if (config === undefined) return undefined;
  if (typeof config !== "string") return config;
  if (!isPolicyPresetName(config)) {
    throw new VendoError(
      "validation",
      `Unknown policy preset "${config}". Valid presets are: ${POLICY_PRESET_NAMES.join(", ")}.`,
    );
  }
  return { rules: POLICY_PRESET_RULES[config] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readPolicyFile(config: PolicyConfigObject): Promise<PolicyFile | undefined> {
  const explicit = config.file !== undefined;
  const file = config.file ?? DEFAULT_POLICY_FILE;
  let readFile: (path: string, encoding: "utf8") => Promise<string>;
  let source: string;

  try {
    ({ readFile } = await import("node:fs/promises"));
  } catch (error) {
    if (!explicit) return undefined;
    throw new VendoError(
      "validation",
      `Unable to load filesystem support for policy file ${file}: ${errorMessage(error)}`,
    );
  }

  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (!explicit && errorCode(error) === "ENOENT") return undefined;
    throw new VendoError(
      "validation",
      `Unable to read policy file ${file}: ${errorMessage(error)}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source);
  } catch (error) {
    throw new VendoError(
      "validation",
      `Invalid JSON in policy file ${file}: ${errorMessage(error)}`,
    );
  }

  const parsed = policyFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new VendoError(
      "validation",
      `Invalid policy file ${file}: ${parsed.error.message}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export class PolicyResolver {
  readonly #config: PolicyConfigObject | undefined;
  #filePromise: Promise<PolicyFile | undefined> | undefined;

  /** Takes the already-resolved object form — string presets are expanded by
   *  `resolvePolicyConfig` at `createGuard` compose time, before this class
   *  ever sees the config. */
  constructor(config: PolicyConfigObject | undefined) {
    this.#config = config;
  }

  async rules(): Promise<PolicyRule[]> {
    if (!this.#config) return [];
    // Inline wins with no merge (00-overview decision 19): when inline rules are
    // set the file is irrelevant, so don't load it — a malformed or missing file
    // must never abort an otherwise-valid inline-only configuration.
    if (this.#config.rules !== undefined) return this.#config.rules;
    return (await this.#file())?.rules ?? [];
  }

  async directions(): Promise<string[]> {
    if (!this.#config) return [];
    if (this.#config.directions !== undefined) return this.#config.directions;
    return (await this.#file())?.directions ?? [];
  }

  async #file(): Promise<PolicyFile | undefined> {
    if (!this.#config) return undefined;
    this.#filePromise ??= readPolicyFile(this.#config);
    return this.#filePromise;
  }
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
}

export function ruleMatches(
  rule: PolicyRule,
  tool: string,
  risk: PolicyRule["match"]["risk"],
  venue: PolicyRule["match"]["venue"],
  presence: PolicyRule["match"]["presence"],
): boolean {
  const match = rule.match;
  return (
    (match.tool === undefined || globMatches(match.tool, tool)) &&
    (match.risk === undefined || match.risk === risk) &&
    (match.venue === undefined || match.venue === venue) &&
    (match.presence === undefined || match.presence === presence)
  );
}
