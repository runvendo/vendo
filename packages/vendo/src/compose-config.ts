/**
 * 09-vendo §2 — the first phase: read the host's config, refuse a miswired one,
 * and resolve the identity + session seams every later phase is handed.
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

/** ENG-237 recommended defaults (documented in the PR body; Yousef-gated as
    09-vendo contract text). */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
export interface ResolvedSessions {
  ttlMs: number;
  sweepIntervalMs: number;
  now?: () => number;
}

function validateSessionsConfig(sessions: CreateVendoConfig["sessions"]): ResolvedSessions {
  const ttlMs = sessions?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const sweepIntervalMs = sessions?.sweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  // ttlMs 0 (or negative) is the documented off switch. Any other value must
  // be a non-negative integer; the sweep interval must be a positive integer.
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new VendoError("validation", "sessions.ttlMs must be a non-negative integer (0 disables TTL eviction)");
  }
  if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new VendoError("validation", "sessions.sweepIntervalMs must be a positive integer");
  }
  return { ttlMs, sweepIntervalMs, ...(sessions?.now === undefined ? {} : { now: sessions.now }) };
}

/** 09-vendo §2 — the config, the identity seams, and the session policy. */
export const composeConfig = (input: CreateVendoConfig): Pick<VendoComposition,
  "appsMounted" | "automationsMounted" | "config" | "composed" | "resolvePrincipal"
  | "actAsSeam" | "oauthSeam" | "membershipsSeam" | "resolvePersonSeam" | "userFactsSeam"
  | "sessionsConfig" | "sessionNow"> => {
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
  // The three seams the identity story fills: from the preset, from the
  // per-seam trio, or — with neither `auth` nor `principal` — the anonymous
  // default resolver (every session ephemeral, 00 conventions "identity
  // optional" / 02-store §4). Absent preset halves leave their seams unset.
  const resolvePrincipal = config.auth?.principal ?? config.principal ?? (async () => null);
  const actAsSeam = config.auth === undefined ? config.actAs : config.auth.actAs;
  const oauthSeam = config.auth === undefined ? config.oauth : config.auth.oauth;
  // Build contract §9.1 — the fourth seam. It rides the preset (there is no
  // per-seam twin: the org query has no meaning without an identity story) and
  // is handed to the wire, the automations engine, and the schedule engine, so
  // an attended request and an unattended fire resolve the SAME answer.
  const membershipsSeam = config.auth?.memberships;
  // Build contract §9.1 companion — the fifth seam, on the same preset and for
  // the same reason: Vendo holds no directory, so only the host can turn what
  // someone typed into the Share dialog into one of its own subjects. Unset, the
  // dialog does not offer to share with one person at all.
  const resolvePersonSeam = config.auth?.resolvePerson;
  // Spec 2026-08-05 §1 — the [User] facts seam rides the preset only (decision
  // 5: no seam for raw principal-trio hosts — a hand-rolled `principal` has no
  // facts channel).
  const userFactsSeam = config.auth?.facts;
  // 02-store §4 (kill-list B3) — ephemeral session policy. Validated like the
  // agent's context config; defaults are the recommended knobs. The store takes
  // the clock per call (register/sweep), so one time source needs no seam.
  // Validated FIRST because the hosted session ops derive their touch-debounce
  // window from the sweep interval.
  const sessionsConfig = validateSessionsConfig(config.sessions);
  const sessionNow = sessionsConfig.now ?? Date.now;
  return {
    appsMounted,
    automationsMounted,
    config,
    composed,
    resolvePrincipal,
    actAsSeam,
    oauthSeam,
    membershipsSeam,
    resolvePersonSeam,
    userFactsSeam,
    sessionsConfig,
    sessionNow,
  };
};
