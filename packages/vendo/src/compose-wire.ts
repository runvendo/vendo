/**
 * The wire's dependency bundle, and the object `createVendo` hands back.
 *
 * The route table and the handler itself stay in server.ts; this is only what
 * the composition supplies them with — plus the two origin learners, which live
 * here because the wire is what validates a request enough to learn from it.
 */
import { VendoError } from "@vendoai/core";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { VendoComposition } from "./compose-context.js";
import { isLoopbackOrigin } from "./door-paths.js";
import { composeAgentTools } from "./agent-tools.js";
import { composeTokenFor } from "./mcp-token.js";
import type { Vendo } from "./types.js";
import { uploadCapOf } from "./user-files.js";
import { VERSION, type WireDeps } from "./wire/shared.js";

const telemetryClient = (enabled: boolean | undefined): Telemetry | undefined => {
  if (enabled !== true) return undefined;
  try {
    return initTelemetry({ version: VERSION, runtime: true });
  } catch {
    return undefined;
  }
};

/** Everything the wire handler reads off this composition. */
export const wireDepsFor = (composition: VendoComposition): WireDeps => {
  const { config, store, ops, guard, apps, actionsConfig, appTokens, automations } = composition;
  const { boundTools, byoApprovals, connections, sandbox, inference, doctor, door } = composition;
  const { resolvePrincipal, membershipsSeam, userFactsSeam, userPoolsSeam, ready } = composition;
  const { appsMounted, automationsMounted } = composition;
  const { runSweep, sweepEnabled, hostedStoreComposed, doorWellKnown, harnessDoor } = composition;
  const { configuredBaseUrl, isDevelopmentEnv } = composition;
  // Minted on first request via the deps getter below — Workers forbids
  // generating random values in global scope, and createVendo runs at module
  // init in the edge wiring. Still one fallback id per process.
  let processSessionId: string | undefined;
  const sessionId = (): string => (processSessionId ??= `session_${globalThis.crypto.randomUUID()}`);
  // An https VENDO_BASE_URL means TLS terminates at a trusted proxy and
  // requests arrive here as http.
  const trustedBaseIsHttps = ((): boolean => {
    if (configuredBaseUrl === undefined) return false;
    try {
      return new URL(configuredBaseUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const development = config.development !== undefined
    ? config.development !== false
    : isDevelopmentEnv;
  return {
    principal: resolvePrincipal,
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    ...(userFactsSeam === undefined ? {} : { userFacts: userFactsSeam }),
    ...(userPoolsSeam === undefined ? {} : { userPools: userPoolsSeam }),
    ready,
    trustedBaseIsHttps,
    get sessionId() { return sessionId(); },
    store,
    ops,
    telemetry: telemetryClient(config.telemetry),
    // Every chat turn goes through the harness runtime — `harness:` when the
    // host named one, `vendo()` when they did not. There is no second engine to
    // fall back to and no boot-time probe deciding between them: a store that
    // can keep neither the transcript nor the workspace (build contract
    // §3.3/§6) refuses THAT TURN inside the door, naming the two ways to give
    // it one. Boot stays up, and the deployment is told the truth the first
    // time someone chats rather than served silently by a lesser engine.
    harness: harnessDoor,
    guard,
    mounted: { apps: appsMounted, automations: automationsMounted },
    apps,
    // execution-v2 Lane C — the /box surfaces: tool calls through the SAME
    // guard binding, bearer verification over the composed store.
    tools: boundTools,
    appTokens,
    automations,
    byoApprovals,
    connections,
    channels: composition.channelDoor,
    channelInboundSecret: composition.channelInboundSecret,
    sandbox: sandbox.venue,
    // The cap and its backing, resolved where the drawer's law lives so this
    // door and `vendo_user_files_put` refuse identically; `files` is the same
    // predicate the boot summary's row prints.
    ...uploadCapOf(config),
    model: inference.agent.venue,
    doctor,
    get mcp() { return composition.mcpPosture; },
    development,
    sweep: runSweep,
    sweepEnabled,
    sweepIntervalMs: composition.sweepConfig.intervalMs,
    sweepNow: composition.sweepNow,
    // Serverless hosts (the hosted store's typical deployment) fire no
    // interval timer, so the authenticated tick carries the sweep for them.
    sweepOnTick: sweepEnabled && hostedStoreComposed,
    ...(door === undefined ? {} : { door }),
    doorWellKnown,
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first VALIDATED request and
      // then fixed.
      if (actionsConfig.baseUrl === undefined) {
        actionsConfig.baseUrl = origin;
        // 09-vendo §2 install-dx wave 1.1: NODE_ENV=development trusts its own
        // learned origin, so present-mode calls forward the caller's `cookie`
        // and `authorization` to it. That trust is fenced to LOOPBACK, because
        // a request origin IS the Host header: without the fence, one request
        // carrying `Host: attacker.evil` fixed the base process-wide and sent
        // the caller's real session cookie and bearer to the attacker on every
        // present-mode call after it (measured, `server.test.ts` SECURITY pins).
        // Same rule and same predicate as the tool door below — one authority.
        //
        // Only the TRUST is fenced, never the base itself: resolving route
        // bindings same-origin with zero config is what the learner is for, and
        // an untrusted base still resolves, exactly as it does in production.
        actionsConfig.baseUrlTrusted = isDevelopmentEnv && isLoopbackOrigin(origin);
      }
      // The TOOL DOOR's own learned origin, kept separate because it answers a
      // different question — not "may credentials ride this?" but "may a turn
      // credential be MINTED against this?". Same loopback rule, first one wins.
      if (composition.learnedLoopbackOrigin === undefined && isDevelopmentEnv && isLoopbackOrigin(origin)) {
        composition.learnedLoopbackOrigin = origin;
      }
    },
  };
};

/** 09-vendo §2 — the handle a host holds: every composed block, plus the two
 *  doors (`handler`, `emit`) that latch readiness on first touch. */
export const vendoInstance = (
  composition: VendoComposition,
  handler: (request: Request) => Promise<Response>,
): Vendo => {
  const { automationsMounted, ready, automations, guard, byoApprovals } = composition;
  const { apps, actions, selectedConnections, store, harnessDoor, channelDoor, ops } = composition;
  const { tenantConnectors } = composition;
  const tokenFor = composeTokenFor(composition, handler);
  return {
    handler,
    tokenFor,
    agentTools: composeAgentTools(composition, handler, tokenFor),
    async usage(query) {
      // Loud, not silent, exactly like `emit` below: a store with no meter
      // recorded nothing and never will, so an empty tally would read as "this
      // deployment's users are idle" to the billing job asking.
      if (ops?.usage === undefined) {
        throw new VendoError(
          "not-implemented",
          "vendo.usage() reads the store's meter, and this deployment's store has no usage meter: "
          + "every tally would come back empty. Use the default store (or any store on schema v10+ — "
          + "Vendo Cloud, your own Postgres via createStore).",
        );
      }
      await ready();
      return ops.usage.tally(query);
    },
    async emit(event, payload, principal) {
      // Loud, not silent: a host still calling `emit` after unmounting
      // automations is a wiring mistake, and answering `[]` would hide it
      // behind "no automation matched that event".
      if (!automationsMounted) {
        throw new VendoError(
          "not-implemented",
          `createVendo({ automations: false }) unmounted the automations engine, so vendo.emit("${event}") has nothing to fire. Remove the flag, or remove the emit call.`,
        );
      }
      await ready();
      return automations.emit(event, payload, principal);
    },
    // The drop door's write, on the root handle: the SAME door the wire's
    // `POST /files` calls, already `ready()`-latched by `harnessDoorFor`.
    putUserFile: harnessDoor.putUserFile,
    guard,
    // The BYO seam (ai-sdk.ts / mastra.ts tool packs) reaches the store
    // without ever touching handler/emit, so its execute leg arms the same
    // ready() latch — the composed-block head start the old eager kick gave
    // such hosts, without the construction-time I/O Workers forbids. Direct
    // vendo.store/automations reach-ins still own their readiness (await
    // store.ensureSchema(), as the mastra example and defer tests do).
    guardedTools: {
      ...byoApprovals.registry,
      execute: async (call, ctx) => {
        await ready();
        return byoApprovals.registry.execute(call, ctx);
      },
    },
    apps,
    automations,
    // The adopted agent, read back: `vendo.agent` is the value the host passed,
    // not a second one — the same object its `.on()` declarations hang off.
    ...(composition.config.agent === undefined ? {} : { agent: composition.config.agent }),
    actions,
    // The adapter rule's object, exactly as selected: an explicitly passed
    // adapter is handed back untouched. The cache-invalidating wrapper is an
    // internal composition detail (see selectedConnections above).
    connections: selectedConnections,
    // Registrations are rows and vaulted secrets, so every leg latches `ready()`
    // for the reason `emit` and the channel legs do: the schema has to be there
    // first. `list`/`test` latch too — they read the same rows.
    tenantConnectors: {
      register: async (input) => {
        await ready();
        return tenantConnectors.register(input);
      },
      list: async (org) => {
        await ready();
        return tenantConnectors.list(org);
      },
      remove: async (org, name) => {
        await ready();
        return tenantConnectors.remove(org, name);
      },
      test: async (org, name) => {
        await ready();
        return tenantConnectors.test(org, name);
      },
    },
    // The named channel surface, over the same door the wire routes call: the
    // host mints a link from its own server code exactly as the anchor does.
    // Each leg latches `ready()` for the same reason `emit` does — every one of
    // them reads or writes the link rows, so the schema has to be there first
    // (the wire's own handler awaits the same latch before routing).
    channels: {
      text: {
        link: async (principal) => {
          await ready();
          return { url: (await channelDoor.invite(principal)).url };
        },
        status: async (principal) => {
          await ready();
          return channelDoor.status(principal);
        },
        unlink: async (principal) => {
          await ready();
          return channelDoor.unlink(principal);
        },
      },
    },
    store,
    // The SAME door the wire's chat route runs (see `harnessDoor`), latched by
    // `ready()` because a harness turn reads the transcript and writes workspace
    // rows, so the schema has to be there first.
    harness: harnessDoor,
  };
};
