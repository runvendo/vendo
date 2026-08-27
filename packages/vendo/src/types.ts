/**
 * 09-vendo §2 — the umbrella's type surface.
 *
 * `Vendo` and `CreateVendoConfig` used to sit ~1,300 lines apart from the
 * composition that implements them, at opposite ends of server.ts. They live
 * here now, beside each other, and `./server.js` re-exports both because that
 * is where every importer names them.
 */
import type {
  ActionsRegistry,
  CatalogFile,
  Connector,
  ExtractedTool,
  OverridesFile,
  ServerActionHandler,
} from "@vendoai/actions";
import type { AppsConfig, SandboxAdapter, AppsRuntime } from "@vendoai/apps";
import type { VendoAgent as ComposedAgent } from "@vendoai/agents";
import type { AutomationsEngine } from "@vendoai/automations";
import type {
  ActAs,
  FilesAdapter,
  Harness,
  Json,
  KnowledgeAdapter,
  LimitsCallback,
  Membership,
  Principal,
  RunId,
  SecretsProvider,
  Skill,
  ToolDefinition,
  ToolRegistry,
  UsageTallyQuery,
  UsageTallyRow,
  VendoLogger,
} from "@vendoai/core";
import type {
  ComponentCatalog,
  ComponentRegistry,
  VendoRouteMap,
  VendoTheme,
} from "@vendoai/apps/contract";
import type { GuardRules, PolicyFile, VendoGuard } from "@vendoai/guard";
import type { ShellLimits } from "@vendoai/harnesses/vendo";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import type { VendoStore } from "@vendoai/store";
import type { VendoAgentTools } from "./agent-tools.js";
import type { HostAuthPreset } from "./auth-presets/index.js";
import type { ConnectionsService } from "./connections.js";
import type { HarnessTurns, UploadedFile } from "./harness-turn.js";
import type { ModelsConfig } from "./models-config.js";
import type { TenantConnectors } from "./tenant-connectors.js";

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  /** One short-lived MCP access token bound to one of YOUR users — what a
      backend agent connects to this deployment's door with, so it acts as that
      user under the same guard and the same audit trail as the in-product one.

      Pass the incoming `Request` and the signed-in user is read off its session
      cookie through the same seam the door authenticates with; pass a user id
      to mint headlessly (a cron, a queue worker). A blank or `"undefined"` id
      is refused rather than minted — a token for a user nobody is would only
      fail much later, as a tool call that finds no data.

      Where the exchange happens is the deployment's posture, not the caller's
      problem: a Vendo Cloud deployment exchanges at its provisioned broker, a
      BYO one at its own door (`mcp.serviceAuth`). The same agent code works
      against both. */
  tokenFor(who: Request | string): Promise<string>;
  /** The door, already wired, for an agent loop the host writes by hand — a
      raw `messages.create` loop rather than the AI SDK or Mastra, which take
      `vendoTools(vendo)` instead.

      Same duality as `tokenFor`: pass the incoming `Request` and it acts as
      whoever is signed in, pass a user id and it acts as them headlessly.

      What comes back is one CONVERSATION's connection: `tools` in the shape
      the Messages API takes, `results(message)` to run what the model picked
      and hand back `tool_result` blocks, and `embeds` — the typed envelopes
      those calls produced, for the page to render. Hold it for the whole
      conversation; the session it opens is what a parked approval resumes on,
      and a ten-minute badge that runs out is re-established underneath.

      In-process, like `tokenFor`: every call rides `handler`, so a deployment
      never has to be able to reach itself over the network. */
  agentTools(who: Request | string): Promise<VendoAgentTools>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  /** Push a file into one user's own drawer from host code — the programmatic
      half of the chat drop, through the SAME server-side write, so the agent
      cannot tell the two apart. It reaches the user the next time they chat;
      nothing is delivered and no turn is started.

      Same name replaces the file that was there (`/user` is last-write-wins),
      which is how "here is this month's export" works without the caller
      inventing version suffixes. The upload door's 5 MiB cap is the DOOR's:
      this is a trusted caller, bounded by the `files:` adapter instead. */
  putUserFile(input: {
    principal: Principal;
    name: string;
    content: Uint8Array | string;
    contentType?: string;
  }): Promise<UploadedFile>;
  guard: VendoGuard;
  /** Existing-agents — the guard-bound registry with BYO approval parking:
      the registry the `vendo_*` tool pack executes through. Same binding
      chat, apps, and automations ride (no unguarded route); the one addition
      is that a `pending-approval` outcome parks the exact call so the wire
      resumes it on approve, discards it on deny, and expires it on the
      parked-call TTL sweep. */
  guardedTools: ToolRegistry;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  /** The agent this deployment adopted (`createVendo({ agent })`), read back —
      the one `.on()` declarations were collected on, reconciled into records at
      boot. Absent when the host composed no agent of its own; the deployment
      still has a brain (the composed harness), and a firing that names no agent
      reaches it. */
  agent?: ComposedAgent;
  actions: ActionsRegistry;
  connections: ConnectionsService;
  /** ONE tenant's own MCP server or OpenAPI spec, registered at runtime with no
      redeploy: `register` saves and tests in one call, and the org's users then
      see the discovered tools — nobody else's do, because each org is served its
      OWN registry rather than a filtered copy of a shared one. The pasted token
      is vaulted in the store's encrypted secrets and is never readable back. */
  tenantConnectors: TenantConnectors;
  /** Where this deployment's users reach the agent besides the web
      (`createVendo({ channels: { text: true } })`). The surface is always
      here; with no channel configured every call refuses by naming the fix. */
  channels: VendoChannels;
  store: VendoStore;
  /** Architecture §3 — THE door every turn is served through: the composed
      `Harness` (`harness:`, or `vendo()`). `POST /threads` routes here, and so
      does a host — or a live proof — driving a turn directly. A store that can
      keep neither the transcript nor the workspace raises the not-implemented
      refusal on the turn rather than degrading to a lesser engine. */
  harness: HarnessTurns;
  /** What the meter recorded, per subject and action, over one window — the
      read a host's own backend job does (an overage sweep, a usage table).
      The window's `since` is required for the same reason the store's is: it
      is the only bound that keeps a call off a drawer that only ever grows.

      This is the OPERATOR's read; a policy asks its own bound `count` instead
      (`limits`), and never names a subject. A deployment whose store has no
      meter is refused here rather than answered with an empty tally: nothing
      was recorded and nothing ever will be, and a billing sweep reading "no
      usage" would bill nobody. */
  usage(query: UsageTallyQuery): Promise<UsageTallyRow[]>;
}

export interface CreateVendoConfig {
  /** Models spec 2026-07-22 (DX surface 3) — the models block, keyed by SEAT
      (one per real job), valued by a model-name string (resolved through
      vendoModel's credential ladder: VERBATIM passthrough, per-rung defaults,
      env pins) or an explicit ai-SDK LanguageModel object (wins as-is).

      `default` is the agent that thinks — chat, compaction, subagents,
      automations; `apps` writes the generated apps; `review` grades the
      finished ones; `judge` answers guard's run/ask/block and only feeds a
      judge the host wired from a string — vendoAutoJudge(
      vendoModel("vendo-judge")) — there is NO judge-on-by-default.

      An unset seat borrows `default`: the object when the host passed one, the
      seat's own rung pick when `default` rode the credential ladder. A
      deployment that sets nothing at all still fills every seat, and fails
      honestly with instructions when no credential exists. */
  models?: ModelsConfig;
  /** 09-vendo §2.1 — the ONE DOOR for everything identity-shaped. It takes
      either spelling of the same value:

      ```ts
      createVendo({ auth: authJs() });               // a preset's result
      createVendo({ auth: {                          // an object you write
        principal: async (req) => resolveSession(req),
        facts: async (req) => ({ plan: "pro" }),
      } });
      ```

      A preset is just a function returning one of these, so nothing here is
      reserved to the preset path — `facts`, `pools`, `memberships`, `actAs` and
      `oauth` are all hand-writable ({@link HostAuthPreset}).

      Mutually exclusive with the deprecated per-seam `principal`/`actAs`/`oauth`
      trio: mixing throws VendoError("validation") at compose time. */
  auth?: HostAuthPreset;
  /** Host session → principal.
      @deprecated Use the one door: `auth: { principal }`. Same function, same
      seam, and `auth` is also where `facts`, `pools`, `memberships`, `actAs`
      and `oauth` live — this key can only ever fill one of them. Still works;
      it just cannot grow. */
  principal?: (req: Request) => Promise<Principal | null>;
  /** Per-seam escape hatch: the caller's orgs and teams, the twin of
      `auth.memberships` for a host on the deprecated `principal` trio. Same
      seam, same precedence as `actAs` and `oauth` — set it and it wins outright.

      Read ONLY when `auth` is unset: `auth` carries its own `memberships`, so a
      config with both silently keeps the one inside `auth`. Put it there.

      This is also how a keyed deployment DECLINES the Cloud tenant directory:
      with `VENDO_API_KEY` set and this seam unset, Vendo resolves memberships
      from Vendo Cloud, so `memberships: async () => []` is how a host says
      "this deployment has no orgs" and no directory is ever constructed. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Architecture §10 — THE host's own tools, as `vendo init` / `vendo sync`
      extract them: the declarations `.vendo/tools.json` carries, passed in
      memory instead of read from disk.

      This is the explicit override, not the quickstart: day one is one key
      (`createVendo({ auth })`) reading `.vendo/` off the project root, and a
      host reaches for `tools:` when the declarations live somewhere the
      filesystem cannot be — a Worker, a per-tenant venue composing from a
      database, a test.

      Precedence: `tools:` wins over the deprecated `profile.tools` (the same
      value under its pre-§10 spelling), which wins over the `profileDir` /
      cwd `tools.json` read. Unset, nothing changes — the file is read exactly
      as before.

      The SAME key also takes a `ToolDefinition` — a descriptor plus an
      `execute` — which is how a third party ships an executable tool: it joins
      the one registry under the name it declared, guarded, audited and
      projected exactly like a host tool. The two shapes are told apart by
      `execute`, and only the declaration shape feeds `.vendo` semantics. */
  tools?: readonly (ExtractedTool | ToolDefinition)[];
  /** Skills the deployment mounts at `/host/skills`, beside the ones its own
      subsystems bring: agentskills.io SKILL.md values a harness lists cheaply
      and loads on demand. Names are global as authored and a collision with
      another contributor fails at boot naming both. */
  skills?: readonly Skill[];
  /** Host components available to generated apps: the name-keyed registry
      object (01 §14 — the same object serves <VendoProvider>; the server ignores
      each entry's `component` reference) or the array form. Entry names must
      mirror the client-side components map 1:1. */
  catalog?: ComponentCatalog | ComponentRegistry;
  /** The host's own pages a generated view may link to, keyed by the name a
      `<Link to>` reaches for. Each entry's `description` is what picks between
      them. The SAME object goes to <VendoProvider>, which resolves a link
      target against it and refuses any name that is not here. */
  routes?: VendoRouteMap;
  /** Programmatic override for the theme surface. An explicit
      theme wins over `.vendo/theme.json` (config-surface precedence). A
      structural, boot-once surface: it is resolved once at compose (feeds app
      generation and the system-prompt summary), so unlike design-rules/brief
      it is not re-read live. */
  theme?: VendoTheme;
  /** THE prose the deployment puts in front of the agent, every turn: what this
      product is, who uses it, the house voice, what to emphasize (03-agent §3).
      One knob — `brief` and `agent.instructions` were the same thing under two
      names, and a host had to guess which one it wanted.

      Programmatic override for the `.vendo/brief.md` surface, which is what
      `vendo init` writes and the CLI keeps maintaining: a non-blank string wins
      over the file (and over `profile.brief`); blank falls through. It rides
      the assembled system prompt's Product section, where the brief has always
      ridden — so a deployment that only has `.vendo/brief.md` sees no change at
      all. Policy belongs in guard directions, not here. */
  instructions?: string;
  store?: VendoStore;
  /** Build contract §3.4 / architecture §10 — where workspace file CONTENT
      lives once it outgrows a database row. Unset, the store's own `vendo_blobs`
      backs it up to `FILES_STORE_MAX_BYTES` (5 MiB) and the first over-cap write
      fails naming this key. Any S3-compatible bucket (S3/R2/Supabase/MinIO)
      is reachable through a host-supplied adapter.

      Resolved ONCE, inside `selectStore`, and handed to every consumer from
      there — the workspace that writes blobs, and the erase/adoption/sweep
      cascade that must delete the same ones. Two adapters would leak objects
      forever behind deleted rows, so the resolution has exactly one home. */
  files?: FilesAdapter;
  sandbox?: SandboxAdapter;
  /** Architecture §3 / §10 — WHO THINKS. Any `Harness`: the built-in `vendo()`,
      a spawned driver, or the host's own via `defineHarness`. Unset means
      `vendo()` — today's loop, on the contract.

      A harness declaring `requires: { sandbox: true }` with no `sandbox`
      adapter is a BOOT error, never a turn that dies in front of a user. */
  harness?: Harness<never>;
  /** Knowledge K1 — the product knowledge base seam (core's KnowledgeAdapter).
      Configured, it composes the `vendo_knowledge_search` agent tool; unset,
      the tool does not exist (precedence: selectKnowledge). */
  knowledge?: KnowledgeAdapter;
  /** Where outside-service tools come from — ONE list, two spellings, mixed
      freely.

      A STRING names a Vendo Cloud connector toolkit (`"gmail"`, `"slack"`):
      the composed cloudTools/cloudConnections pair is scoped to exactly the
      strings in this list, so the discovery index, the executable tools and the
      connect dock's catalog all bind to the same set instead of lazily
      advertising the console's whole catalog. Strings need VENDO_API_KEY —
      without one there is no broker, so the toolkits mount nothing and the
      connect surface refuses by naming the key (the honest unconfigured path,
      never a silent drop).

      A {@link Connector} OBJECT is an explicit provider (`composioConnector({…})`,
      `cloudTools({…})`, a host's own) and is used verbatim.

      Unset lets VENDO_API_KEY default the unscoped Cloud connector, exactly as
      before; an empty array is still a choice ("no connectors"). */
  connectors?: readonly (string | Connector)[];
  /** 04-actions §3 — an explicit connections adapter; always wins over the
      defaults (precedence: selectConnections). */
  connections?: ConnectionsService;
  /** Scoped auth material for away host-API execution.
      @deprecated Use the one door: `auth: { principal, actAs }`. */
  actAs?: ActAs;
  /** 04-actions §1 (ENG-248): the server-action registration map emitted by the
      generated wiring file, keyed `"<module>#<exportName>"`. Server-action tools
      dispatch in-process through it; a missing key fails closed at execution. */
  serverActions?: Record<string, ServerActionHandler>;
  /** The remix wiring `vendo sync` generates for this project's `<Remixable>`
      components (`.vendo/generated/remix-wiring.ts`), keyed by slot. The whole
      hookup is one line — import the generated const and pass it here — and the
      file is regenerated by every sync, reviewed in a git diff, and never edited
      by hand.

      Per slot, `tools` binds the ported component's envelope names to the
      host's OWN functions, already wrapped as tools. They join the one registry
      under the names they declare, so the deployment's guard grades them and
      the audit trail records them exactly as it does a host tool. This slot
      buys the wiring no execution path and no exemption of its own; WHAT it may
      bind is settled upstream, by the sync that wrote the file and the diff the
      host read. Two slots that fetch the same envelope bind the same tool, and a
      tool name is global, so that is one tool rather than a collision.

      `holes` binds the component names the port renders as holes to the
      host/npm components themselves, and ONE catalog governs both ends of that
      name: it joins the component catalog here, so the checks floor types the
      ported screen against the same names the renderer paints by. A `catalog`
      entry for the same name wins, because a hole carries nothing but a name.
      The component REFERENCE is the client's half, untouched here exactly as a
      catalog entry's `component` is (01 §14); it reaches the renderer through
      `<VendoProvider components>`, the map a host node is resolved by name
      from. */
  remixWiring?: Record<string, { tools?: Record<string, ToolDefinition>; holes?: Record<string, unknown> }>;
  /** 05-guard — the deployment's choke point, as ONE value.

      `guard({ policy, judge, approvals })` from `@vendoai/guard` declares the
      host's RULES and lets this composition finish them: the store, the app/
      service risk resolver and the org-policy layer
      are plumbing only a venue can supply, so they are never on the spec (the
      same standalone-value-completed-by-the-venue shape `vendo()` and `agent()`
      already use). A built `VendoGuard` — `createGuard({ store, … })` — is
      taken VERBATIM instead, adapter-rule style: this composition adds nothing
      to it, so a host that wants the resolver and the org layer passes rules,
      not an instance. Unset composes the same unconfigured-posture guard it
      always did. */
  guard?: VendoGuard | GuardRules;
  /** Per-user limits, in the host's own logic: Vendo counts, this decides.

      Called once before each metered action (a user message, an app
      generation) with the resolved user, the action, and a `count` reader
      already bound to that user. Answer `false` — or `{ allow: false, message }`
      to say why in your own words — and the action is refused and never
      counted; anything else allows it and the meter records it.

      The counting is Vendo's: it needs a store with a `usage` meter, so a
      policy against a store that has none is REFUSED at composition rather
      than enforced against counts that are all zero. A policy that throws
      DENIES (and logs `limits.callback_error`) — a limits system that fails
      open stops limiting silently. Unset wires nothing at all. */
  limits?: LimitsCallback;
  secrets?: SecretsProvider;
  /** Where everything Vendo says out loud goes (core's `log.ts`): one structured
      event per line Vendo would have written to the console, so a host can route
      it into its own observability or quieten it. A host-passed logger ALWAYS
      wins; unset is today's console lines, unchanged. */
  logger?: VendoLogger;
  telemetry?: boolean;
  /** Development-only surfaces: the `vendo sync` blast-radius probe
      (POST /sync/impact), and the composition probes (/doctor/machines,
      /doctor/present, /doctor/act-as and their echoes) — none of them even
      mounted without this.
      NODE_ENV=development enables them; `false` disables the environment
      default. Unset with any other NODE_ENV — or none, or a runtime with no
      `process` at all — leaves them closed. /doctor/base-url is the one
      exception and answers in every environment. */
  development?: boolean;
  /** The project root the `.vendo/` profile is read
      under: the actions files (tools.json/overrides.json, read by the actions
      registry this composition builds with `dir`), theme.json, brief.md,
      catalog.json, the per-generation design-rules.md read, and the remixable
      pin baselines all resolve against it. Unset keeps today's
      behavior (the process cwd), so a host can mount a real composition over a
      profile living in a temp directory without chdir. */
  profileDir?: string;
  /** The fetch host route/OpenAPI tool bindings execute
      through, threaded verbatim into the actions registry. An explicitly
      passed function always wins (adapter rule); unset keeps the platform
      fetch. */
  fetch?: typeof fetch;
  /** The `.vendo/` profile pieces as IN-MEMORY compose-time inputs, for
      deployments with no filesystem (the `profileDir` seam cannot reach
      them). Precedence PER PIECE, each independent of the others:
      `profile.<piece>` (in-memory, wins) → the `profileDir` file → the cwd
      default. A caller may pass only `tools` + `theme` and still read
      `brief.md` from disk. Each piece's type is exactly what the
      corresponding file read parses today (the zod-inferred file shapes —
      never a new shape): `tools`/`overrides` ride the actions
      registry's existing in-memory inputs and are validated THERE (its
      config-parse posture: a malformed piece throws `validation` loudly —
      note the registry loads lazily, so that throw surfaces on the FIRST
      ACTIONS USE (`actions.descriptors()`/`execute()`, or the first turn
      that loads tools), not at `createVendo` itself — wrap that call);
      `theme`/`brief`/`catalog` are trusted typed config, the same
      posture as the existing `catalog` key (zod parsing exists for untyped
      file bytes, not typed config). `policy` is the parsed `policy.json`
      document (the guard's `PolicyFile` shape — what the file read parses
      into today), for a deployment that holds its policy in memory instead of
      on disk; the longer-standing explicit
      `policy` knob wins over it (the `apps.designRules` discipline), and
      when the piece applies it feeds the guard inline, replacing the
      file leg entirely. `designRules` is a convenience alias for
      `apps.designRules` — one seam, so a host composing everything from one
      profile object doesn't have to split it; when both are set the
      longer-standing `apps.designRules` knob wins, and either fixes the rules
      for the instance lifetime exactly as `apps.designRules` documents.
      Unset `profile` (or any unset piece) keeps today's behavior unchanged. */
  profile?: {
    tools?: ExtractedTool[];
    overrides?: OverridesFile;
    theme?: VendoTheme;
    brief?: string;
    catalog?: CatalogFile;
    policy?: PolicyFile;
    designRules?: string;
  };
  /** 10-mcp §1 — the one flag: open the MCP door so outside agents (Claude,
      ChatGPT, Cursor) reach the host's tools through the SAME guard-bound path.
      Opening it is a host decision (10-mcp §2), so it is off by default.
      The additive object form opens the door with options: `baseUrl` is the
      canonical PUBLIC base URL the door's discovery metadata, issuer, resource
      identifiers, and RFC 8707 audience binding derive from — set it (or
      `VENDO_BASE_URL`, the default) behind a reverse proxy, where the request
      URL carries the proxy-internal origin. Forwarded headers are never
      trusted. `remoteAs` (10-mcp §3.1) trusts an external authorization server
      — e.g. the hosted broker at `{tenant}.mcp.vendo.run` — instead of serving
      the door's local OAuth surface, and `federation` (10-mcp §3.2) answers
      that server's signed login handshake at `{mount}/federate`.
      `serviceAuth` opens first-party service auth: the host's OWN backend
      exchanges one of these keys plus a user id for a short-lived user-bound
      token at the door's token endpoint (rotation is listing both keys until
      the old one is out of use). */
  mcp?: boolean | {
    baseUrl?: string;
    remoteAs?: { issuer: string; jwksUri?: string; audience: string };
    federation?: { secret: string };
    serviceAuth?: { keys: readonly string[] };
  };
  /** The agent's hands over the user's own files (spec 2026-08-23 §1): one
      in-process `bash` over the workspace, on the same guarded registry as
      everything else. ON by default — a deployment's users drop files into chat
      whether or not anyone configured anything, and an agent that cannot open
      them is the whole problem this exists to fix.

      `false` withholds the tool entirely. The object form keeps it and moves its
      ceilings: `limits.maxExecutionTimeMs` (default 30 000) is one call's wall
      clock, `limits.maxOutputBytes` (default 1 000 000) is how much one call may
      produce before the shell stops it.

      It rides the RESIDENT BRAIN, not the deployment: `vendo()` runs in this
      process and has the workspace in hand, so the tool composes for it and for
      an `agent()` that adopted it. A harness that thinks on a MACHINE
      (`claudeCode()`) already has a real disk and reaches it its own way, so this
      flag is silently irrelevant there rather than half-wired. */
  shell?: boolean | { limits?: ShellLimits };
  /** 10-mcp §3 plus its additive prebuilt flow — the host's session + identity
      seam. REQUIRED when `mcp` is true: the door cannot mint principals
      without it.
      @deprecated Use the one door: `auth: { principal, oauth }`. */
  oauth?: HostOAuthAdapter;
  /** A whole agent built by `agent()` from `@vendoai/agents` — the seam the
      agents-v0 spec names ("Vendo's embed consumes it across a real seam").

      This deployment ADOPTS what that agent already composed:
      its harness (who thinks), its store and blob adapter (where the
      transcript and the workspace live), its sandbox (with the agent-level
      egress skin and its boot audit row), and its `instructions`. Passing any
      of those a second time at the top level is a conflict and throws at
      construction rather than letting one side silently lose.

      What stays this deployment's: the guard (the embed's choke point carries
      org policy and app-tool risk grading a standalone agent has no notion of)
      and the host tool surface (`.vendo/tools.json`). The agent's own guard and
      tools keep serving its own `session()` calls. */
  agent?: ComposedAgent;
  /** MORE agents this deployment can fire automations through, by name. Each
      one keeps its own brain, voice and skills; `support.on("0 9 * * 1", …)`
      declares the work and this list is what makes the name resolvable, so a
      firing lands on the agent that declared it rather than on a fallback.

      Registration only — nothing here serves chat turns, and two agents sharing
      a name refuse to compose. `agent:` above is a different key: that one this
      deployment ADOPTS (its harness, store and instructions become the
      deployment's), these are named beside it. */
  agents?: readonly ComposedAgent[];
  /** The TTL sweep's cadence. One pass expires orphaned parked BYO calls and
      stranded approvals (both on `guard.approvals.parkedCallTtlMs`), so the
      cadence belongs to the deployment rather than to either feature.
      - `intervalMs` how often the amortized on-request sweep and the unref'd
        background timer run (default 60 s).
      - `now` internal clock seam (tests only). */
  sweep?: {
    intervalMs?: number;
    now?: () => number;
  };
  /** How much of one tool's response may reach the model, in characters
      (default DEFAULT_TOOL_OUTPUT_CAP; `0` disables). Composition's, not the
      thinker's: the same number bounds the agent loop's context, the harness
      bridge, and the connector-discovery registry's own search results, and a
      harness cannot reach two of those three. */
  toolOutputCap?: number;
  /** What one browser upload may carry through the drop door (`POST /files`),
      in bytes. Default UPLOAD_MAX_BYTES (5 MiB). A DOOR cap, not a storage cap:
      `vendo.putUserFile` is a trusted server caller and is bounded by whatever
      backs `files:` instead. */
  uploadMaxBytes?: number;
  /** ENG-252 — cap on the uncurated initial tool loadout; the rest stay
      discoverable via `find_tools`. Defaults to the agent block's
      DEFAULT_MAX_INITIAL_TOOLS. A discovery-rail knob, and the rail is built
      here and handed to BOTH thinkers, so it stays on the composition. */
  maxInitialTools?: number;
  /** ENG-252 — explicit curated initial loadout by tool name. When set,
      exactly these host tools (that exist and are enabled) start active — the
      cap is not applied; the rest stay discoverable via `find_tools`. Vendo's
      own `vendo_*` tools are always active. Same rail, same reason, as
      `maxInitialTools`. */
  loadout?: readonly string[];
  /** Apps-block options.

      Machine-backed execution (layer 2) has no flag: it is gated by exactly one
      thing, a configured `sandbox` adapter, because configuring one IS the
      deliberate opt-in. A layer-3 SERVED app — the machine serving the app
      surface itself, embedded in a sandboxed iframe — additionally needs a
      mounted wire to serve it THROUGH (`createVendo().handler`, which answers
      /apps/:appId/serve/**). A deployment missing either hears it as a plain
      "cannot" in the plan rather than as a flag.

      `false` UNMOUNTS app generation: its tools (`vendo_make`, the
      `vendo_apps_*` set) are absent from the registry, its `building-apps`
      skill is absent from the mount, and the `/apps/**` wire surface answers
      not-found. Honest absence — the AGENT genuinely cannot build apps and
      says so, rather than being handed tools that refuse. The host's own
      `vendo.apps` runtime handle stays: unmounting is about what the agent and
      the wire offer, never about taking your server code's API away. */
  apps?: false | {
    /** The island smoke-render gate: every generated island renders once in a
        headless DOM before it can reach a screen. ON unless explicitly false. */
    pipeline?: AppsConfig["pipeline"];
    /** The host's own checks over a generated app: each one reports findings
        (`block` stops the app shipping as-is, `warn` rides along) the same way
        the built-in fact checks and the AI reviewer do. APPENDED to the
        built-ins — a host adds findings, it never removes one. */
    checks?: AppsConfig["checks"];
    /** Host design rules for app generation (spec 2026-07-20): the same prose
        `.vendo/design-rules.md` carries, for hosts that prefer programmatic
        config. A non-blank string wins over the file and is fixed for the
        instance lifetime; unset/blank falls through to a PER-GENERATION read
        of the file, so editing it applies to the next create/edit without a
        restart. */
    designRules?: string;
  };
  /** `false` UNMOUNTS automations: the `/automations/**` and `/runs/**` wire
      surfaces answer not-found, `vendo.emit` refuses, and THE LAW's
      unattended-irreversibility rule leaves the reviewer's rubric with the
      subsystem it belongs to. Nothing fires while nobody is watching, and the
      absence is audible rather than a silently inert engine.

      Only `false` today, because the subsystem has no other host-facing knob;
      it widens to an options object the day it grows one. */
  automations?: false;
  /** Where this deployment's users can reach the agent besides the web.
      `{ text: true }` opens the TEXT channel: a user links their phone from
      inside the product (one anchor to `/api/vendo/channels/text/link`) and
      from then on texts the agent, which acts as them exactly as it does in a
      web chat. Vendo Cloud carries the numbers and the delivery, so the flag
      needs VENDO_API_KEY; without one the surface refuses by naming the key
      (precedence: selectChannels). Unset, the channel is simply not there.

      The phone ↔ user binding lives in THIS deployment's store
      (`vendo_channel_links`) and nowhere else: Cloud knows how to reach the
      deployment, never who its users are. */
  channels?: { text?: boolean };
}

/** The text channel's host-facing surface — what `vendo.channels.text` is. */
export interface TextChannelApi {
  /** Mint this user's claim code and answer the URL that opens their messages
      app with the first text prefilled. The wire route
      `GET /api/vendo/channels/text/link` is the same thing behind an anchor. */
  link(principal: Principal): Promise<{ url: string }>;
  /** Whether this user has a phone linked, masked for display. */
  status(principal: Principal): Promise<{ linked: boolean; phone?: string }>;
  unlink(principal: Principal): Promise<void>;
}

export interface VendoChannels {
  text: TextChannelApi;
}

/** The options `apps:` carries when app generation IS mounted — derived rather
 *  than declared, so the config surface stays one inline shape. */
export type AppsOptions = Exclude<CreateVendoConfig["apps"], false | undefined>;
