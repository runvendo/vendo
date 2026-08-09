/**
 * 09-vendo §2 — the first phase: read the host's config, refuse a miswired one,
 * and resolve the identity seams every later phase is handed.
 *
 * Everything here runs BEFORE anything is constructed, so a config that fills a
 * slot twice leaks no resources on its way to the error.
 */
import { agentComposition, type AgentComposition } from "@vendoai/agents";
import { VendoError } from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";
import { rejectRemovedConfigKeys, warnDeprecatedConfigKeys } from "./config-keys.js";
import type { AppsOptions, CreateVendoConfig } from "./types.js";

/** The slots a composed agent brings, and therefore the keys that may not also
    be passed at the top level. Kept beside the adoption in `adoptAgent` so the
    error can never drift from what is actually taken. */
const AGENT_OWNED_KEYS = ["harness", "store", "files", "sandbox", "instructions"] as const;

/** The seam: read what `agent()` composed, and refuse a config that fills any
    of the same slots twice. Runs before anything is constructed, so a miswired
    config leaks no resources. */
function adoptAgent(config: CreateVendoConfig): AgentComposition | undefined {
  if (config.agent === undefined) return undefined;
  const composed = agentComposition(config.agent);
  if (composed === undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ agent }) was handed something `agent()` from @vendoai/agents did not build — pass the value that `agent({ … })` returned.",
    );
  }
  const conflicts = AGENT_OWNED_KEYS.filter((key) => config[key] !== undefined);
  if (conflicts.length > 0) {
    throw new VendoError(
      "validation",
      `createVendo({ agent }) already brings ${conflicts.map((key) => `\`${key}\``).join(", ")} from the agent it was built with; remove ${conflicts.length === 1 ? "it" : "them"} from createVendo, or move ${conflicts.length === 1 ? "it" : "them"} into agent({ … }) — one slot, one owner.`,
    );
  }
  return composed;
}

/** ENG-237 recommended default (documented in the PR body; Yousef-gated as
    09-vendo contract text). */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
export interface ResolvedSweep {
  intervalMs: number;
  now?: () => number;
}

function validateSweepConfig(sweep: CreateVendoConfig["sweep"]): ResolvedSweep {
  const intervalMs = sweep?.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new VendoError("validation", "sweep.intervalMs must be a positive integer");
  }
  return { intervalMs, ...(sweep?.now === undefined ? {} : { now: sweep.now }) };
}

/** 09-vendo §2 — the config, the identity seams, and the sweep cadence. */
export const composeConfig = (input: CreateVendoConfig): Pick<VendoComposition,
  "appsMounted" | "automationsMounted" | "config" | "composed" | "resolvePrincipal"
  | "actAsSeam" | "oauthSeam" | "membershipsSeam" | "userFactsSeam"
  | "sweepConfig" | "sweepNow"> => {
  // Whether each subsystem mounts, decided once. `apps: false` is folded away
  // here so the hundred reads below stay `config.apps?.x`: an unmounted
  // subsystem has no options, which is the same thing as none configured.
  const appsMounted = input.apps !== false;
  const automationsMounted = input.automations !== false;
  const config: Omit<CreateVendoConfig, "apps"> & { apps?: AppsOptions } = {
    ...input,
    ...(input.apps === false ? { apps: undefined } : { apps: input.apps }),
  };
  // §10 consolidation — a deprecated key still works, and says where it went.
  // Once per key per process: a deployment composes once, but a multi-tenant
  // venue composes per session and repeated advice is noise nobody reads.
  warnDeprecatedConfigKeys(config as Record<string, unknown>);
  // …and a key that is GONE refuses to compose, naming its replacement. Types
  // catch this for a TypeScript host; a JavaScript one would otherwise lose its
  // `policy` silently and run wide open, which is the one failure mode a config
  // change must never have.
  rejectRemovedConfigKeys(config as Record<string, unknown>);
  // 09-vendo §2.1 — one preset or the per-seam trio, never mixed. Checked
  // before anything is constructed so a miswired config leaks no resources.
  if (config.auth !== undefined) {
    const mixed = (["principal", "actAs", "oauth"] as const)
      .filter((key) => config[key] !== undefined);
    if (mixed.length > 0) {
      throw new VendoError(
        "validation",
        `createVendo({ auth }) already fills the principal, actAs, and oauth seams from one preset (09-vendo §2.1); remove ${mixed.map((key) => `\`${key}\``).join(", ")} or drop \`auth\` — one preset or the per-seam trio, never mixed.`,
      );
    }
  }
  // agents-v0 §Product — the embed's seam onto @vendoai/agents. Checked here,
  // beside the auth mixing check and for the same reason: a slot filled twice
  // is a wiring mistake the host hears about before anything is constructed.
  const composed = adoptAgent(config);
  // The three seams the identity story fills: from the preset or from the
  // per-seam trio. Absent preset halves leave their seams unset — but the
  // principal is not optional. Vendo mints no principals of its own, so a
  // deployment with neither `auth` nor `principal` has no one to serve and
  // says so here, beside the other config refusals, before anything is built.
  const resolvePrincipal = config.auth?.principal ?? config.principal;
  if (resolvePrincipal === undefined) {
    throw new VendoError(
      "validation",
      "createVendo needs an identity: add `principal: async () => ({ kind: \"user\", subject: \"dev\" })` "
      + "(or an `auth` preset). Vendo no longer mints anonymous sessions.",
    );
  }
  const actAsSeam = config.auth === undefined ? config.actAs : config.auth.actAs;
  const oauthSeam = config.auth === undefined ? config.oauth : config.auth.oauth;
  // Build contract §9.1 — the fourth seam. It rides the preset (there is no
  // per-seam twin: the org query has no meaning without an identity story) and
  // is handed to the wire, the automations engine, and the schedule engine, so
  // an attended request and an unattended fire resolve the SAME answer.
  const membershipsSeam = config.auth?.memberships;
  // Spec 2026-08-05 §1 — the [User] facts seam rides the preset only (decision
  // 5: no seam for raw principal-trio hosts — a hand-rolled `principal` has no
  // facts channel).
  const userFactsSeam = config.auth?.facts;
  // The TTL sweep's cadence and clock. One timer serves both surviving legs
  // (expired parked BYO calls and stranded approvals), so the knob is the
  // deployment's, not either feature's. `now` is the internal clock seam the
  // TTL tests drive.
  const sweepConfig = validateSweepConfig(config.sweep);
  const sweepNow = sweepConfig.now ?? Date.now;
  return {
    appsMounted,
    automationsMounted,
    config,
    composed,
    resolvePrincipal,
    actAsSeam,
    oauthSeam,
    membershipsSeam,
    userFactsSeam,
    sweepConfig,
    sweepNow,
  };
};
