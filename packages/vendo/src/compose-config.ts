/**
 * 09-vendo §2 — the first phase: read the host's config, refuse a miswired one,
 * and resolve the identity seams every later phase is handed.
 *
 * Everything here runs BEFORE anything is constructed, so a config that fills a
 * slot twice leaks no resources on its way to the error.
 */
import { agentComposition, type AgentComposition } from "@vendoai/agents";
import { unsupportedRouteParams } from "@vendoai/apps/contract";
import { VendoError } from "@vendoai/core";
import { cloudDirectory } from "./cloud-directory.js";
import type { VendoComposition } from "./compose-context.js";
import { cloudKeyOptions } from "./compose-selection.js";
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

/** 09-vendo §2 — a route whose path uses a `:param` shape the resolver cannot
    fill, refused HERE rather than at render.

    A `:param` is a whole path segment. `/posts/:slug.html` takes no parameter at
    all, so `resolveVendoRoute` hands back a path still carrying `:slug.html`
    even when the caller supplies `slug` — and the floor and the briefing read it
    the same wrong way, so neither refuses the route nor tells generation to fill
    it. Every link to that page is silently dead.

    Registration is the earliest moment anyone can be told, and the only one
    where the fix is obvious, so the whole failure becomes one boot error a host
    reads once. Suffixes are rejected rather than parsed: a path grammar is real
    surface in a module that also ships to the browser, and support can be added
    later without breaking anyone — withdrawing it could not. */
function validateRouteConfig(routes: CreateVendoConfig["routes"]): void {
  const refused = Object.entries(routes ?? {}).flatMap(([name, route]) => {
    const bad = unsupportedRouteParams(route.path);
    return bad.length === 0 ? [] : [
      `route "${name}" has path "${route.path}", where ${bad.map((segment) => `"${segment}"`).join(", ")} `
      + `${bad.length === 1 ? "is" : "are"} neither a parameter nor plain text`,
    ];
  });
  if (refused.length > 0) {
    throw new VendoError(
      "validation",
      `createVendo({ routes }): ${refused.join("; ")}. In a registered path a :param must be a WHOLE path segment, `
      + `so "/accounts/:id" works and "/accounts/:id-2" does not — nothing can fill a partial one, and every link to `
      + `that page would render as plain text and go nowhere. Give the value its own segment ("/accounts/:id/2"), or `
      + `drop the colon if the text is literal.`,
    );
  }
}

/** The upload door's cap, against the only thing a byte count can be. Typed
    config is trusted for TYPES, which does not cover this: `NaN` and `Infinity`
    are numbers, and both make the doors' `bytes > cap` false forever — so a
    config slip does not move the door, it DELETES it. Refused here rather than
    clamped, because a silent fall back to the default hides the slip. */
function validateUploadMaxBytes(uploadMaxBytes: CreateVendoConfig["uploadMaxBytes"]): void {
  if (uploadMaxBytes !== undefined && (!Number.isInteger(uploadMaxBytes) || uploadMaxBytes < 1)) {
    throw new VendoError(
      "validation",
      `createVendo({ uploadMaxBytes }): must be a positive integer, got ${uploadMaxBytes}`,
    );
  }
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
  | "actAsSeam" | "oauthSeam" | "membershipsSeam" | "directory" | "userFactsSeam" | "userPoolsSeam"
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
  // …and a registered path whose `:param` the resolver could never fill, for the
  // same reason and in the same place: a wiring mistake the host hears about
  // before anything is constructed, rather than as a dead link months later.
  validateRouteConfig(config.routes);
  validateUploadMaxBytes(config.uploadMaxBytes);
  // 09-vendo §2.1 — one preset or the per-seam keys, never mixed. Checked
  // before anything is constructed so a miswired config leaks no resources.
  // `memberships` is in the list for the reason the others are, and harder: it
  // decides whether Vendo asks Cloud who the caller's orgs are, so a top-level
  // one lost to `auth.memberships` handed a host the directory they thought
  // they had just declined.
  if (config.auth !== undefined) {
    const mixed = (["principal", "actAs", "oauth", "memberships"] as const)
      .filter((key) => config[key] !== undefined);
    if (mixed.length > 0) {
      throw new VendoError(
        "validation",
        `createVendo({ auth }) already fills the principal, actAs, oauth and memberships seams from one preset (09-vendo §2.1); remove ${mixed.map((key) => `\`${key}\``).join(", ")} or drop \`auth\` — one preset or the per-seam keys, never mixed.`,
      );
    }
  }
  // One registry, one name: `components` is what `<VendoProvider>` already
  // called it, and `catalog` is the same slot under its old spelling. Setting
  // both is a config that cannot be read two ways without picking a winner
  // silently, so it refuses here beside the other slot-filled-twice checks.
  if (config.components !== undefined && config.catalog !== undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ components }) and createVendo({ catalog }) are the same component registry; "
      + "keep `components` (the name `<VendoProvider components>` already uses) and drop `catalog`.",
    );
  }
  // agents-v0 §Product — the embed's seam onto @vendoai/agents. Checked here,
  // beside the auth mixing check and for the same reason: a slot filled twice
  // is a wiring mistake the host hears about before anything is constructed.
  const composed = adoptAgent(config);
  // The seams the identity story fills: from `auth` — a preset's result or the
  // object a host wrote, one door either way — or from the deprecated per-seam
  // trio. Absent halves leave their seams unset, but the principal is not
  // optional. Vendo mints no principals of its own, so a deployment with
  // neither `auth` nor `principal` has no one to serve and says so here, beside
  // the other config refusals, before anything is built. The fix names the ONE
  // DOOR, never the deprecated key: an error message is where most hosts learn
  // this API's shape, so it may only ever teach the shape we want them on.
  const resolvePrincipal = config.auth?.principal ?? config.principal;
  if (resolvePrincipal === undefined) {
    throw new VendoError(
      "validation",
      "createVendo needs an identity: add "
      + "`auth: { principal: async () => ({ kind: \"user\", subject: \"dev\" }) }` "
      + "(or a preset — `auth: authJs()`). Vendo no longer mints anonymous sessions.",
    );
  }
  const actAsSeam = config.auth === undefined ? config.actAs : config.auth.actAs;
  const oauthSeam = config.auth === undefined ? config.oauth : config.auth.oauth;
  // Build contract §9.1 — the fourth seam, handed to the wire, the automations
  // engine and the schedule engine, so an attended request and an unattended
  // fire resolve the SAME answer. It has a per-seam twin like `actAs` and
  // `oauth` above: once VENDO_API_KEY can FILL this seam, the twin is the only
  // way a host on the `principal` trio can refuse the Cloud directory, and a
  // default nobody can refuse is a mandate.
  const membershipsSeam = config.auth === undefined ? config.memberships : config.auth.memberships;
  // ADAPTER RULE, memberships seam: an explicitly asserted seam always wins and
  // short-circuits the whole directory — with it set, no client is constructed
  // and Cloud is never called. Only a wholly unset seam lets VENDO_API_KEY
  // default the hosted directory (selectConnections' precedence,
  // compose-selection.ts). One place, so the wire, the harness, the automations
  // engine and the MCP door all inherit it.
  const cloud = membershipsSeam === undefined ? cloudKeyOptions() : undefined;
  const directory = cloud === undefined ? undefined : cloudDirectory(cloud);
  // Spec 2026-08-05 §1 — the [User] facts seam rides `auth`, in either of its
  // spellings: a preset's result or the object a host wrote. It has no per-seam
  // twin on purpose. The deprecated top-level `principal` is a bare function
  // with nowhere to hang a second seam, which is the whole reason `auth` is the
  // one door — a host who wants facts writes `auth: { principal, facts }`.
  const userFactsSeam = config.auth?.facts;
  // The limits pools seam rides the same door for the same reason.
  const userPoolsSeam = config.auth?.pools;
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
    membershipsSeam: membershipsSeam ?? directory?.memberships,
    directory,
    userFactsSeam,
    userPoolsSeam,
    sweepConfig,
    sweepNow,
  };
};
