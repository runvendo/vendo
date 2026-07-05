/**
 * `createFlowletFetchHandler()` — the framework-agnostic Web Fetch API
 * handler behind every Flowlet framework adapter (`@flowlet/next` today).
 * Point any router at it — a Next.js catch-all, an Express/Hono bridge,
 * a raw `Bun.serve` — and it serves everything Flowlet needs from one place.
 *
 * Endpoints (relative to the route's mount, keyed on the LAST path segment
 * so any mount prefix works):
 *   POST /chat          — streamed agent turn (host tools via the caller seam)
 *   POST /action        — sandbox dispatch through the policy (+ approval tokens)
 *   GET|POST /integrations — Composio connect flow (inert without the key)
 *   GET  /capabilities  — { chat, integrations, voice, mcp } from env-key/config presence
 *   GET  /deliveries    — in-app Channels feed for FlowletToasts (single-tenant)
 *   POST /tick          — drives the automations scheduler
 *   POST /resume        — resumes a paused automation run (approval toast)
 *   POST /consent       — answers a ConsentRequest; server-validates grant
 *                          creation (ENG-193)
 *   POST /fade-proposal — resolves a fade proposal (ENG-193 §4.4)
 *   GET  /parked-actions — parked automation drafts (ENG-193 §4.6)
 *   POST /parked-actions/resolve — resolves a parked draft (ENG-193 §4.6)
 *   GET  /grants        — Trust screen: federated grants (standing + automation) (ENG-193 §3 Moment 12)
 *   POST /grants/revoke — Trust screen: revoke a standing grant (ENG-193 §3 Moment 12)
 *   GET  /rules         — Trust screen: compiled always-ask rules (ENG-193 item 6)
 *   POST /rules/revoke  — Trust screen: revoke a rule (ENG-193 item 6)
 *   GET  /audit         — Trust screen: audit query (ENG-193 §3 Moment 12)
 *   GET  /critical-tools — Trust screen: tools that always need the human (ENG-193 §3 Moment 12)
 *   anything else       — 404 JSON error
 *
 * ZERO-CONFIG: with no options it reads `.env` (capability-additive keys) and
 * `.flowlet/` (theme, tools manifest) and just works — ANTHROPIC_API_KEY alone
 * gives working chat + generated UI.
 */
import assert from "node:assert";
import type { ToolSet } from "ai";
import { prewiredComponents } from "@flowlet/components/descriptors";
import { DrizzleAutomationStore, setMeta } from "@flowlet/store";
import {
  buildDescriptor,
  createBreakerState,
  createConsentLedger,
  createFadeTracker,
  createInMemoryCompiledRuleStore,
  createInMemoryGrantStore,
  createSteeringTools,
  hostToolset,
  InMemoryAuditLog,
  InMemoryThreadStore,
  type InstructionContext,
} from "@flowlet/runtime";
import { handleChat } from "./chat";
import { handleAction, createApprovalStore } from "./action";
import { handleConsentRoute } from "./consent";
import { handleFadeProposalRoute } from "./fade-proposal";
import { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";
import { listGrantsRoute, revokeGrantRoute, listRulesRoute, revokeRuleRoute, queryAuditRoute, listCriticalToolsRoute } from "./trust";
import {
  DEFAULT_INTEGRATION_CATALOG,
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
} from "./integrations";
import { detectCapabilities } from "./capabilities";
import { loadFlowletDir } from "./flowlet-dir";
import { resolveMcpServers } from "./mcp-config";
import { manifestToolsToHostTools } from "./manifest-tools";
import { buildInstructions, createAgentCache } from "./agent";
import { createSourceResolver } from "./remix-enrich";
import { resolveRemixSealer } from "./seal";
import { createAutomationsWorld, type FlowletAutomationsWorld } from "./world";
import { resolveModel } from "./model";
import { defaultFlowletPolicy } from "./default-policy";
import { composeProductionPolicy, EMBEDDED_TENANT } from "./policy-stack";
import { createThreadIndex } from "./threads";
import { resolvePrincipal, tickServiceAuth, DEFAULT_PRINCIPAL } from "./guard";
import { resolveStorage } from "./storage";
import { parseHandlerOptions, type FlowletHandlerOptions } from "./options";
import { handleComposioWebhook } from "./webhooks";

const FIRST_SEGMENTS = new Set([
  "chat",
  "action",
  "integrations",
  "capabilities",
  "deliveries",
  "tick",
  "resume",
  "consent",
  "fade-proposal",
  "parked-actions",
  "grants",
  "rules",
  "audit",
  "critical-tools",
  "webhooks",
  "threads",
  "flowlets",
]);

/**
 * Everything after the catch-all mount: the suffix starting at the FIRST
 * known segment (scanning right-to-left so a host route named e.g.
 * `/threads/...` upstream can't confuse it). The mount itself can't be
 * assumed to be `api/flowlet` — hosts choose their own path.
 *
 * Boundary: an opaque id equal to a reserved first segment (a thread
 * literally named "chat") would shorten the tail. Ids here are UUIDs, so
 * routes carrying ids must keep it that way.
 */
export function routeTail(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (FIRST_SEGMENTS.has(segments[i]!)) return segments.slice(i).join("/");
  }
  return segments[segments.length - 1] ?? "";
}

export type FlowletFetchHandler = (req: Request) => Promise<Response>;

/** Everything the routes (and the scheduler boot hook) need, assembled once. */
export type FlowletState = Awaited<ReturnType<typeof assembleFlowletState>>;

// Assembly is lazy (first request / scheduler boot): framework adapters
// (e.g. `next build`) import route modules at build time, and reading
// `.flowlet/` or requiring keys there would break builds in clean CI
// environments. Async because provider resolution loads optional peer
// packages via dynamic import; the memoized promise (createLazyState) keeps
// the lazy-on-first-request behavior.
async function assembleFlowletState(options: FlowletHandlerOptions) {
    const loaded = loadFlowletDir(options.flowletDir);
    // MCP servers: the code option OVERRIDES the file entirely; ${ENV_VAR}
    // header substitution applies only to file-sourced entries (code already
    // runs in an env-aware context). A server whose var is missing is dropped
    // with a warning. The capability flag reads the RESOLVED list.
    const mcpServers = options.mcpServers ?? resolveMcpServers(loaded.mcpServers ?? []);
    const capabilities = {
      ...detectCapabilities(undefined, { hasInjectedModel: options.model !== undefined }),
      mcp: mcpServers.length > 0,
    };
    const hostTools = options.hostTools ?? manifestToolsToHostTools(loaded.manifest.tools);
    const model = options.model ?? (await resolveModel());
    const grants = options.store?.grants ?? createInMemoryGrantStore();
    const rules = options.store?.rules ?? createInMemoryCompiledRuleStore();
    const audit = options.store?.audit ?? new InMemoryAuditLog();
    const threads = options.store?.threads ?? new InMemoryThreadStore(() => new Date().toISOString());
    const threadIndex = createThreadIndex(threads);
    const breakers = options.store?.breakers ?? createBreakerState();
    const fadeTracker = options.store?.fadeTracker ?? createFadeTracker();
    // Review follow-up: per-(principal, toolCallId) consent idempotency —
    // constructed ONCE here, alongside every other singleton dep this mount
    // owns (grants/audit/fadeTracker/breakers), not per-request. A duplicate
    // consent POST (double-click, client retry) would otherwise re-record a
    // fade decision, append another audit event, and attempt a second grant.
    const consentSeen = createConsentLedger();
    // ENG-193 item 2/3: the production stack wraps the host's base policy —
    // grants can suppress repeat approvals (never critical), a judge (off by
    // default) can tighten/loosen the act tier, deterministic breakers can
    // only tighten, and audit records executes.
    const basePolicy = options.policy ?? defaultFlowletPolicy;
    const policy = composeProductionPolicy(basePolicy, { grants, rules, audit, judgeModel: options.judgeModel, breakers });
    const catalog = options.integrations ?? DEFAULT_INTEGRATION_CATALOG;
    const connections = options.connections ?? createConnectionsStore(catalog);

    // The shared FlowletDb handle: `null` means in-memory (storage: false, or
    // the NODE_ENV=test default — see storage.ts). Only the engine store is
    // wired durably this task; decision/thread/flowlet/connections stores
    // reuse this same handle in later tasks.
    const storage = await resolveStorage(options);
    if (storage === null && process.env["NODE_ENV"] === "production") {
      console.warn(
        "[flowlet] no durable storage configured in production (NODE_ENV=production) — " +
          "automations are running against an in-memory store and will NOT survive a " +
          "restart or scale past one instance. Pass a `storage` option (PGlite dataDir " +
          "or a Postgres connectionString) to persist them.",
      );
    }
    if (storage !== null && options.principal) {
      console.warn(
        "[flowlet] durable storage is configured, but the automations world remains " +
          "single-tenant: a custom `principal` resolver gates who may reach the " +
          "endpoints, but every caller still shares one automation store scope. " +
          "Multi-tenant installs must front their own per-user store/world " +
          "(see docs/quickstart.md → Deploying).",
      );
    }
    const engineStore = storage ? new DrizzleAutomationStore(storage) : undefined;

    // SINGLE-TENANT (see world.ts): one embedded scope for the store, the
    // deliveries feed, and approval resumes.
    const worldScope = { tenantId: EMBEDDED_TENANT, subject: DEFAULT_PRINCIPAL.userId };
    const world: FlowletAutomationsWorld | null =
      options.automations === false
        ? null
        : await createAutomationsWorld({
            policy,
            model,
            ...(options.automations?.tools ? { tools: options.automations.tools } : {}),
            scope: worldScope,
            ...(engineStore ? { store: engineStore } : {}),
            // ENG-193 §4.6/§6.2: parked-action resolutions get the SAME
            // "consent" audit trail chat approvals already do.
            audit,
          });

    // ENG-193 item 6: steering tools merge into the same static "control"
    // bucket automation authoring tools use (ENG-193 PR #40 review — item A:
    // renamed from "engine" to "control" to stop the host's OWN server tools
    // from riding this same, judge/breaker-exempt bucket) — fixed embedded
    // principal, same single-tenant simplification world.ts documents.
    // `resolveDescriptor` and `knownToolNames` are forward references into
    // this closure — safe, `controlTools`/`serverTools` are never CALLED
    // until `assemble()` has fully run and all three consts are bound
    // (`resolveDescriptor` itself back-references `controlTools()` already;
    // `knownToolNames` does too, one line below).
    //
    // PRINCIPAL ASYMMETRY (review follow-up, item-6 plan's open-risks
    // section, now resolved below): the rest of this mount re-resolves the
    // Principal PER REQUEST — `resolvePrincipal(req, options)` maps whatever
    // identity the host's `options.principal` resolver returns into
    // `{ tenantId: EMBEDDED_TENANT, subject: guard.principal.userId }` fresh
    // on every grants/rules/audit/consent call (see the GET/POST handlers
    // below, and policy-stack.ts's `principalScope`). Steering tools do NOT:
    // they mint rules/grants under this ONE fixed `DEFAULT_PRINCIPAL`-derived
    // subject at construction time, identical to the single-tenant
    // simplification `world.ts` documents for automation authoring tools
    // (this bucket merges into that SAME static toolset). On a host with a
    // custom multi-tenant `principal` resolver, every user's "always ask
    // before"/"stop asking about" utterance would land on this ONE shared
    // identity instead of the caller's own — a false "Got it" for anyone but
    // DEFAULT_PRINCIPAL's subject. Until steering tools resolve their
    // principal per-request too (declared follow-up — needs a request-scoped
    // toolset, which this construction-time closure doesn't have), the safe
    // fix is to not register them at all on a custom-principal (multi-user)
    // mount; the default single-principal mount (no `principal` option)
    // keeps them, since DEFAULT_PRINCIPAL IS the one identity every request
    // on that mount runs as. The assertion below is a cheap sanity check
    // (not a multi-tenant guard) that the fixed identity this bucket relies
    // on is actually well-formed.
    assert(
      typeof DEFAULT_PRINCIPAL.userId === "string" && DEFAULT_PRINCIPAL.userId.length > 0,
      "steering tools require a non-empty fixed DEFAULT_PRINCIPAL.userId (single-tenant assumption, ENG-193 item-6)",
    );
    // ENG-193 PR #40 review (item A): the HOST's own server tools
    // (`options.tools`) must stay SEPARATE from Flowlet's control-plane tools
    // (steering + automation authoring) — `createFlowletAgent` labels them
    // "engine" vs "control" respectively, and only "control" is exempt from
    // the judge/`cautionBreaker`/`volumeBreaker`. Merging them into one
    // bucket (the pre-fix shape) let a host's own business tools ride the
    // control-plane exemption.
    const hostServerTools = (): ToolSet =>
      typeof options.tools === "function" ? options.tools() : options.tools ?? {};

    const controlTools = (): ToolSet => ({
      ...(world ? world.authoringTools() : {}),
      // Custom `options.principal` resolver -> multi-user mount -> steering
      // tools are withheld entirely (see the comment above).
      ...(options.principal === undefined
        ? createSteeringTools({
            principal: { tenantId: EMBEDDED_TENANT, subject: DEFAULT_PRINCIPAL.userId },
            rules, grants, audit,
            resolveDescriptor: (name) => resolveDescriptor(name),
            knownToolNames: () => knownToolNames(),
          })
        : {}),
    });

    // Union of both, for name resolution ONLY (knownToolNames/critical-tools
    // route) — never fed to the engine as one bucket (see above).
    const serverTools = (): ToolSet => ({ ...hostServerTools(), ...controlTools() });

    // Default prompt is a per-run FUNCTION (spec §1/§7): the capability
    // summary needs the live merged toolset, which only exists after tool
    // ingestion inside the engine's run().
    const instructions =
      options.instructions ??
      ((ctx: InstructionContext) =>
        buildInstructions({
          productName: options.productName ?? "this app",
          brand: loaded.brand,
          components: options.components ?? [],
          hostToolNames: hostTools.map((t) => t.name),
          integrations: capabilities.integrations ? catalog : [],
          automations: world !== null,
          toolSummary: ctx.toolSummary,
          ...(options.instructionsExtra ? { extra: options.instructionsExtra } : {}),
        }));

    // Remix-source enrichment: option first, then flowlet sync's capture
    // (re-read from disk in dev; see remix-enrich.ts).
    const resolveRemixSource = createSourceResolver({
      ...(options.remixSources ? { option: options.remixSources } : {}),
      captured: loaded.remixSources,
    });

    // Pin-envelope sealing (remix fast-edits). No key material → pin editing
    // degrades to the anchor baseline; everything else is unaffected.
    const remixSealer = resolveRemixSealer({
      sealSecret: options.sealSecret,
      hasInjectedModel: options.model !== undefined,
    });

    const getAgent = createAgentCache({
      model,
      policy,
      instructions,
      ...(loaded.envManifest ? { envManifest: loaded.envManifest } : {}),
      // The engine's render_view registry must know the prewired catalog too —
      // host-node validation rejects any name it can't find (ENG-186).
      components: [...prewiredComponents, ...(options.components ?? [])],
      tools: hostServerTools,
      controlTools,
      ...(capabilities.integrations ? { toolkits: () => connections.connectedToolkits() } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(remixSealer ? { remixSealer } : {}),
      // ENG-193 §6.2: persist each SETTLED run's full message list to the
      // thread store. This is the single writer for thread messages (chat.ts
      // deliberately does NOT persist the request body) — the streamed
      // assistant turn, with any approval-requested parts, must be in the
      // store BEFORE the client's consent POST arrives, which happens before
      // any next chat turn. The engine hands back the same threadId chat.ts
      // resolved and passed into run(), so the fixed hook can attribute each
      // settled list to the right thread.
      //
      // Continuation turns (host-tool resumes, approval resumes) REVISE the
      // trailing assistant message in place — ai's onFinish returns
      // `[...originalMessages.slice(0, -1), state.message]`, the SAME length
      // as what a previous settle stored — so an append-only prefix delta
      // silently drops the revision (live-verification bug, 2026-07-04: the
      // approval-requested part never reached the store and consent 404'd).
      // `ThreadStore.replaceMessages` (optional seam member, additive like
      // `Store.grants`) persists the full settled list; stores without it
      // fall back to the old prefix delta, which is correct for append-only
      // turns and best-effort for continuations.
      // ENG-193 review follow-up (queued gap): the Trust diary's audit
      // read never saw client-executed host-tool calls (no server execute
      // for the normal onExecuted hook to observe) — the engine now audits
      // them itself from the run's incoming history. Same EMBEDDED_TENANT
      // scoping every other audit write on this mount already uses
      // (policy-stack.ts's `principalScope`).
      audit,
      auditPrincipal: (p) => ({ tenantId: EMBEDDED_TENANT, subject: p.userId }),
      onSettled: async ({ messages, threadId, principal }) => {
        const scope = { tenantId: EMBEDDED_TENANT, subject: principal.userId };
        // Skip runs whose threadId isn't a store-assigned thread (a direct
        // getAgent().run caller with no resolved thread) — the writes below
        // throw on unknown ids and the engine would just log the noise.
        if (!(await threads.get(scope, threadId))) return;
        if (threads.replaceMessages) {
          await threads.replaceMessages(scope, threadId, messages);
          return;
        }
        const existing = await threads.getMessages(scope, threadId);
        const toAppend = messages.slice(existing.length);
        if (toAppend.length > 0) {
          await threads.appendMessages(scope, threadId, toAppend);
        }
      },
    });

    // Static tool-descriptor resolver for the consent endpoint (ENG-193 §4.5
    // ruling (c): "resolve the LIVE descriptor from the engine's registered
    // toolset"). Exact for host tools and server tools whose objects carry
    // annotations; act+unverified for Composio names, which carry no
    // annotations on this path. Even if a live Composio descriptor ever
    // differed, `grantPolicy` re-checks the LIVE tier before suppressing, so
    // a mis-minted grant can never fire on a critical tool — item-1 invariant.
    const clientTools = hostToolset(hostTools);
    const resolveDescriptor = (toolName: string) => {
      const client = clientTools[toolName];
      if (client) return buildDescriptor(toolName, client, "caller");
      // Control-plane tools resolve to source "control" (grant-hash parity
      // with the live engine descriptor, ENG-193 PR #40 review — item A) —
      // checked BEFORE the host's own server tools so a same-named host tool
      // can never masquerade as control-plane here.
      const control = controlTools()[toolName];
      if (control) return buildDescriptor(toolName, control, "control");
      const server = hostServerTools()[toolName];
      if (server) return buildDescriptor(toolName, server, "engine");
      if (/^[A-Z]+_[A-Z_]+$/.test(toolName)) return buildDescriptor(toolName, {}, "composio");
      return undefined;
    };

    // Every tool name registered on this mount RIGHT NOW: host + server +
    // automation-authoring (+ this steering bucket itself, via serverTools()).
    // Shared by the `GET /critical-tools` route below and by
    // `createSteeringTools`'s `always_ask_before` validation (review
    // follow-up, FALSE-ASSURANCE FIX in steering-tools.ts) — one list, one
    // definition. Does NOT include live Composio tool names beyond whatever
    // `serverTools()`/`clientTools` already carry: those are fetched
    // per-turn from Composio's MCP for the connected toolkits and are not
    // statically enumerable here, same pre-existing limitation the
    // `critical-tools` route already had.
    const knownToolNames = (): string[] => [
      ...Object.keys(clientTools),
      ...Object.keys(serverTools()),
      ...(world ? Object.keys(world.authoringTools()) : []),
    ];

    return {
      capabilities,
      hostTools,
      policy,
      connections,
      world,
      worldScope,
      serverTools,
      getAgent,
      resolveRemixSource,
      remixSealer,
      approvals: createApprovalStore(),
      grants,
      rules,
      audit,
      threads,
      threadIndex,
      resolveDescriptor,
      knownToolNames,
      fadeTracker,
      consentSeen,
      clientTools,
      // The shared durable handle (null = in-memory). Reused by later tasks
      // to wire the decision/thread/flowlet/connections stores durably too.
      storage,
    };
}

/** Memoize the assembly promise, but drop it on rejection so the next
 *  request retries fresh (a transient boot failure — DB blip, bad
 *  FLOWLET_MODEL, missing peer — must not brick every request until process
 *  restart). The identity check keeps a late rejection from clobbering a
 *  newer assembly. */
function createLazyState(options: FlowletHandlerOptions): () => Promise<FlowletState> {
  let assembled: Promise<FlowletState> | null = null;
  return () => {
    if (!assembled) {
      const p = assembleFlowletState(options);
      p.catch(() => {
        if (assembled === p) assembled = null;
      });
      assembled = p;
    }
    return assembled;
  };
}

// ---------------------------------------------------------------------------
// Process-wide boot registry — ONE world per process (first-wins).
//
// `createFlowletFetchHandler()` is called from the adapter's route file and
// `startFlowletScheduler()` (boot.ts) from e.g. Next.js instrumentation.ts —
// usually in SEPARATE modules with separate options objects. Both must land
// on the same assembled state, or the started scheduler would tick a
// different world than the one requests write automations into. The rule is
// deliberately simple:
//
//   - The first caller to need state claims the slot; its options win.
//   - A later caller with the SAME options object, or with NO options at all
//     (the instrumentation.ts shape), reuses the slot.
//   - A later `createFlowletFetchHandler` with DIFFERENT non-empty options
//     gets its own private world (its options — e.g. a `principal` resolver —
//     must never be silently ignored); `ensureFlowletState` instead reuses
//     the slot with a warning, since the boot hook has nothing else to start.
//
// Keyed by a module-scope Symbol on globalThis so Next dev-mode module
// re-evaluation still converges on one registry per process.
// ---------------------------------------------------------------------------

interface BootRegistry {
  slot: { options: FlowletHandlerOptions; state: () => Promise<FlowletState> } | null;
  /** startFlowletScheduler's once-latch (see boot.ts). */
  schedulerStarted: boolean;
}

const BOOT_REGISTRY_KEY = Symbol("flowlet.server.bootRegistry");

/** @internal Shared with boot.ts; not part of the public API. */
export function bootRegistry(): BootRegistry {
  const g = globalThis as { [BOOT_REGISTRY_KEY]?: BootRegistry };
  return (g[BOOT_REGISTRY_KEY] ??= { slot: null, schedulerStarted: false });
}

/** @internal Test-only: clears the first-wins slot and the scheduler latch. */
export function resetFlowletBootRegistry(): void {
  const registry = bootRegistry();
  registry.slot = null;
  registry.schedulerStarted = false;
}

function isEmptyOptions(options: FlowletHandlerOptions): boolean {
  return Object.keys(options).length === 0;
}

/**
 * The process-wide lazy state used by `startFlowletScheduler()` (boot.ts).
 * First-wins: reuses the first-assembled state when one exists; passing
 * DIFFERENT non-empty options at that point is a misuse (warned, ignored) —
 * give instrumentation.ts the same options object as the route, or none.
 *
 * @internal
 */
export function ensureFlowletState(rawOptions: FlowletHandlerOptions = {}): Promise<FlowletState> {
  const registry = bootRegistry();
  if (registry.slot) {
    if (!isEmptyOptions(rawOptions) && rawOptions !== registry.slot.options) {
      console.warn(
        "[flowlet] startFlowletScheduler() was called with different options than the " +
          "first-assembled Flowlet state — first-wins: reusing the existing world and " +
          "ignoring these options. Pass the same options object from instrumentation.ts " +
          "as the route handler uses, or pass none.",
      );
    }
    return registry.slot.state();
  }
  const state = createLazyState(parseHandlerOptions(rawOptions));
  registry.slot = { options: rawOptions, state };
  return state();
}

export function createFlowletFetchHandler(rawOptions: FlowletHandlerOptions = {}): FlowletFetchHandler {
  const options = parseHandlerOptions(rawOptions);

  // Share the process-wide world when compatible (same options object, or
  // this handler is zero-config); otherwise assemble privately and claim the
  // slot if still free. See the BootRegistry comment above.
  const registry = bootRegistry();
  let state: () => Promise<FlowletState>;
  if (registry.slot && (registry.slot.options === rawOptions || isEmptyOptions(rawOptions))) {
    state = registry.slot.state;
  } else {
    state = createLazyState(options);
    if (!registry.slot) {
      registry.slot = { options: rawOptions, state };
    } else {
      // Forking a private world: its own InProcessScheduler is NOT the one
      // startFlowletScheduler() started, so its schedules only fire via
      // POST /tick. Say so instead of diverging silently.
      console.warn(
        "[flowlet] createFlowletFetchHandler() was called with different options than the " +
          "first-assembled Flowlet state — this handler gets its own private world whose " +
          "internal scheduler is not started. Its schedules fire only via POST /tick. " +
          "Pass the same options object everywhere (route + instrumentation.ts), or none.",
      );
    }
  }

  /** A boot (assembly) failure surfaces as a 500, not an unhandled rejection. */
  function bootError(err: unknown): Response {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  async function GET(req: Request, s: FlowletState): Promise<Response> {
    switch (routeTail(req)) {
      case "capabilities":
        return Response.json(s.capabilities);
      case "integrations":
        return handleIntegrationsGet(req, {
          store: s.connections,
          enabled: s.capabilities.integrations,
          options,
        });
      case "deliveries": {
        // FlowletToasts polls this: in-app Channels deliveries since a cursor.
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        // SINGLE-TENANT world (see world.ts): the feed belongs to the world's
        // fixed subject. Under a custom multi-user principal resolver, other
        // subjects must NOT read it — fail closed rather than leak run
        // summaries across users (Codex review, 2026-07-04).
        if (guard.principal.userId !== s.worldScope.subject) {
          return Response.json(
            { error: "automation deliveries are single-tenant; front your own world for multi-user installs" },
            { status: 403 },
          );
        }
        const raw = Number(new URL(req.url).searchParams.get("since") ?? "0");
        const since = Number.isFinite(raw) && raw >= 0 ? raw : 0;
        return Response.json({ deliveries: s.world.channels.listSince(s.worldScope, since) });
      }
      case "parked-actions": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listParkedActionsRoute(req, { world: s.world, principal: guard.principal });
      }
      case "grants": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listGrantsRoute(req, {
          grants: s.grants,
          world: s.world,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      case "rules": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listRulesRoute(req, { rules: s.rules, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "audit": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return queryAuditRoute(req, { audit: s.audit, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "critical-tools": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listCriticalToolsRoute(req, { toolNames: s.knownToolNames(), resolveDescriptor: s.resolveDescriptor });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  async function POST(req: Request, s: FlowletState): Promise<Response> {
    switch (routeTail(req)) {
      case "chat":
        return handleChat(req, {
          getAgent: s.getAgent,
          hostTools: s.hostTools,
          options,
          resolveRemixSource: s.resolveRemixSource,
          ...(s.remixSealer ? { remixSealer: s.remixSealer } : {}),
          // capabilities.chat is the single source of truth: it already
          // folds in an injected model (via hasInjectedModel above) alongside
          // any configured provider key.
          chatEnabled: s.capabilities.chat,
          threadIndex: s.threadIndex,
        });
      case "action":
        return handleAction(req, {
          getTools: s.serverTools,
          policy: s.policy,
          approvals: s.approvals,
          options,
          // Review follow-up: SAME source-mapping resolver the chat/consent
          // path uses, so a grant minted from chat/steering (hashed with its
          // "engine"/"control" source) matches the descriptor this route
          // builds for the identical host/control tool — see action.ts's
          // ActionDeps docstring.
          resolveDescriptor: s.resolveDescriptor,
        });
      case "integrations":
        return handleIntegrationsPost(req, {
          store: s.connections,
          enabled: s.capabilities.integrations,
          options,
        });
      case "tick": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        // Service auth first: an external cron (vercel.json, Cloudflare Cron
        // Trigger) presents FLOWLET_TICK_SECRET as a bearer token — no user
        // principal involved. A wrong bearer is always a hard 401 (never a
        // fall-through); no bearer at all takes the normal principal path.
        const service = tickServiceAuth(req);
        if (service === "denied") {
          return Response.json({ error: "invalid tick credential" }, { status: 401 });
        }
        if (service !== "allowed") {
          const guard = await resolvePrincipal(req, options);
          if (!guard.ok) return guard.response;
        }
        await s.world.tick();
        // Liveness heartbeat for durable installs — fire-and-forget: a meta
        // write failure must never fail the tick itself.
        if (s.storage) {
          const handle = s.storage;
          void setMeta(handle, "scheduler_heartbeat", { at: new Date().toISOString() }).catch(
            (err: unknown) => console.error("[flowlet] failed to record scheduler heartbeat:", err),
          );
        }
        return Response.json({ ok: true });
      }
      case "webhooks/composio":
        // No principal guard: the Svix-style signature IS the authentication
        // (see webhooks.ts). A host `principal` resolver has no bearing here —
        // Composio, not a logged-in user, is the caller.
        return handleComposioWebhook(req, { world: s.world, connections: s.connections });
      case "resume": {
        // Approval toast → resume the paused run. Unknown/already-settled runs
        // answer `stale` (the toast flips to its stale state) instead of 500.
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        // Same single-tenant fail-closed rule as /deliveries: only the world's
        // subject may resume its paused runs.
        if (guard.principal.userId !== s.worldScope.subject) {
          return Response.json(
            { error: "automation resume is single-tenant; front your own world for multi-user installs" },
            { status: 403 },
          );
        }
        const body = (await req.json().catch(() => ({}))) as {
          runId?: unknown;
          approved?: unknown;
          stepId?: unknown;
        };
        if (typeof body.runId !== "string" || body.runId.length === 0) {
          return Response.json({ error: "runId is required" }, { status: 400 });
        }
        const run = await s.world.runner.resume(
          s.worldScope,
          body.runId,
          body.approved === true,
          typeof body.stepId === "string" ? body.stepId : undefined,
        );
        if (!run) return Response.json({ stale: true });
        return Response.json({
          run: { id: run.id, status: run.status, outcome: run.outcome ?? null },
        });
      }
      case "consent": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleConsentRoute(req, {
          grants: s.grants,
          audit: s.audit,
          threads: s.threads,
          threadIndex: s.threadIndex,
          resolveDescriptor: s.resolveDescriptor,
          fadeTracker: s.fadeTracker,
          seen: s.consentSeen,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      case "fade-proposal": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleFadeProposalRoute(req, {
          fadeTracker: s.fadeTracker,
          grants: s.grants,
          audit: s.audit,
          resolveDescriptor: s.resolveDescriptor,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      // POST /api/flowlet/parked-actions/resolve (ENG-193 §4.6) — `routeTail`
      // resolves the full suffix from the first known segment, so the nested
      // route matches on its complete tail (no last-segment ambiguity).
      case "parked-actions/resolve": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return resolveParkedActionRoute(req, { world: s.world, principal: guard.principal });
      }
      // POST /api/flowlet/grants/revoke AND POST /api/flowlet/rules/revoke
      // (ENG-193 §3 Moment 12/item-6) — full-tail keys keep them distinct.
      case "grants/revoke":
      case "rules/revoke": {
        const isRuleRevoke = routeTail(req) === "rules/revoke";
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        const principal = { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId };
        return isRuleRevoke
          ? revokeRuleRoute(req, { rules: s.rules, audit: s.audit, principal })
          : revokeGrantRoute(req, { grants: s.grants, audit: s.audit, principal });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  return async function flowletFetchHandler(req: Request): Promise<Response> {
    let s: FlowletState;
    try {
      s = await state();
    } catch (err) {
      return bootError(err);
    }
    switch (req.method) {
      case "GET":
        return GET(req, s);
      case "POST":
        return POST(req, s);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  };
}
