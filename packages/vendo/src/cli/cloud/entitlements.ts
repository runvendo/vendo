export const CAPABILITY_KEYS = [
  "sharing",
  "registry",
  "guard_basic",
  "pinning",
  "guard_full",
  "session_replay",
  "insights",
  "mcp_broker",
  "sso_saml",
  // ENG-263 (block-actions design §C): org machinery ships OSS, activation is
  // key-gated. OSS defines the wire the console must serve; parseContractV2
  // defaults a missing capability to false, so keys stay org-less until the
  // console starts granting it.
  "orgs",
] as const;

export type CapabilityKey = typeof CAPABILITY_KEYS[number];

export const METER_KEYS = ["sandbox_minutes", "runs", "storage_gb"] as const;

export type MeterKey = typeof METER_KEYS[number];

export interface MeterUsage {
  included: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

/** INFORMATIONAL ONLY. Never branch on plan.id/name/status anywhere. */
export interface Plan {
  id: string;
  name: string;
  status: string;
}

export interface ContractCachePolicy {
  ttl_seconds: number;
  stale_if_error_seconds: number;
}

export interface ContractV2 {
  valid: true;
  contract_version: 2;
  org: Organization;
  plan: Plan;
  capabilities: Record<CapabilityKey, boolean>;
  limits: Record<MeterKey, MeterUsage>;
  cache: ContractCachePolicy;
}

const DEFAULT_METER: MeterUsage = {
  included: 0,
  used: 0,
  remaining: 0,
  exhausted: false,
};

const DEFAULT_CACHE: ContractCachePolicy = {
  ttl_seconds: 600,
  stale_if_error_seconds: 86400,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function meterUsage(value: unknown): MeterUsage {
  const meter = record(value);
  return {
    included: finiteNumber(meter.included),
    used: finiteNumber(meter.used),
    remaining: finiteNumber(meter.remaining),
    exhausted: typeof meter.exhausted === "boolean" ? meter.exhausted : false,
  };
}

export function parseContractV2(value: unknown): ContractV2 | null {
  const source = record(value);
  if (source.contract_version !== 2 || source.valid !== true) return null;

  const org = record(source.org);
  const plan = record(source.plan);
  const capabilities = record(source.capabilities);
  const limits = record(source.limits);
  const cache = record(source.cache);

  return {
    valid: true,
    contract_version: 2,
    org: {
      id: stringValue(org.id),
      name: stringValue(org.name),
      slug: stringValue(org.slug),
    },
    plan: {
      id: stringValue(plan.id),
      name: stringValue(plan.name),
      status: stringValue(plan.status),
    },
    capabilities: {
      sharing: capabilities.sharing === true,
      registry: capabilities.registry === true,
      guard_basic: capabilities.guard_basic === true,
      pinning: capabilities.pinning === true,
      guard_full: capabilities.guard_full === true,
      session_replay: capabilities.session_replay === true,
      insights: capabilities.insights === true,
      mcp_broker: capabilities.mcp_broker === true,
      sso_saml: capabilities.sso_saml === true,
      orgs: capabilities.orgs === true,
    },
    limits: {
      sandbox_minutes: meterUsage(limits.sandbox_minutes),
      runs: meterUsage(limits.runs),
      storage_gb: meterUsage(limits.storage_gb),
    },
    cache: {
      ttl_seconds: finiteNumber(cache.ttl_seconds, DEFAULT_CACHE.ttl_seconds),
      stale_if_error_seconds: finiteNumber(
        cache.stale_if_error_seconds,
        DEFAULT_CACHE.stale_if_error_seconds,
      ),
    },
  };
}

export const FREE_CONTRACT: ContractV2 = {
  valid: true,
  contract_version: 2,
  org: { id: "", name: "", slug: "" },
  plan: { id: "free", name: "Free", status: "degraded" },
  capabilities: {
    sharing: false,
    registry: false,
    guard_basic: false,
    pinning: false,
    guard_full: false,
    session_replay: false,
    insights: false,
    mcp_broker: false,
    sso_saml: false,
    orgs: false,
  },
  limits: {
    sandbox_minutes: { ...DEFAULT_METER, exhausted: true },
    runs: { ...DEFAULT_METER, exhausted: true },
    storage_gb: { ...DEFAULT_METER, exhausted: true },
  },
  cache: { ...DEFAULT_CACHE },
};

export function isVendoKey(key: string): boolean {
  return /^vnd_[0-9a-f]{40}$/.test(key);
}
