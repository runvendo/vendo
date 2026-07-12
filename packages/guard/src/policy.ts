import { VendoError } from "@vendoai/core";
import type { PolicyConfig, PolicyFile, PolicyRule } from "./types.js";
import { policyFileSchema } from "./types.js";

const DEFAULT_POLICY_FILE = ".vendo/policy.json";

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

async function readPolicyFile(config: PolicyConfig): Promise<PolicyFile | undefined> {
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
  readonly #config: PolicyConfig | undefined;
  #filePromise: Promise<PolicyFile | undefined> | undefined;

  constructor(config: PolicyConfig | undefined) {
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
