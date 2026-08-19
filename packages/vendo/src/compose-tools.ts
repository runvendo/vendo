/**
 * The rest of the ONE registry: the connector-discovery pair (only as far as an
 * adapter backs it), the knowledge tool, the user's file-drawer reads, and the
 * capability-miss surface the agent reports an unfulfillable ask through.
 */
import type { Connector } from "@vendoai/actions";
import { consoleLogger, emitUsage, setLogger, setUsageSink, type Json } from "@vendoai/core";
import { createKnowledgeTools, knowledgeIndexResolver } from "@vendoai/knowledge";
import { workspaceStore } from "@vendoai/store";
import {
  capabilitySurfaceSnapshot,
  createCapabilityMissCapture,
  type CapabilitySurfaceSnapshot,
} from "./capability-misses.js";
import type { VendoComposition } from "./compose-context.js";
import {
  cloudKeyOptions,
  DEFAULT_TOOL_OUTPUT_CAP,
  selectKnowledge,
} from "./compose-selection.js";
import { connectorDiscoveryRegistry } from "./connector-discovery.js";
import { dotVendoFile } from "./dot-vendo.js";
import { createSdkEvents, sdkRuntime, withSdkErrorReporting } from "./sdk-events.js";
import { createUserFilesTools } from "./user-files.js";
import { environment } from "./wire/shared.js";

/** The discovery tools' ports. Each body only runs on a real tool call, long
 *  after createVendo has returned, so the seams it reads may be composed later. */
const connectorDiscoveryPorts = (
  composition: VendoComposition,
  catalogConnectors: Connector[],
  serviceCatalog: boolean,
): Parameters<typeof connectorDiscoveryRegistry>[0] => ({
    ...(serviceCatalog ? {
      // The BROKER's own search, not ours. Composio is never named here — a
      // connector fills the slot or nothing does. `findCtx` is the CALLER's, so
      // each match's `connected` is that person's answer, not the deployment's,
      // and the fan-out is over the SAME connectors `use_service_tool` can
      // reach, or the model would be handed rows it can never run.
      find: async (need, findCtx) => (await Promise.all(
        catalogConnectors.map((connector) => connector.searchTools!(need, findCtx)),
      )).flat(),
      // The outcome travels back VERBATIM: the guard lifts its `connectorAccount`
      // passthrough onto the audit row, which is how a connector call gets its
      // toolkit named without a second audit path. `undefined` = no connector
      // serves this slug, and the tool turns that into "search first".
      use: async (slug, args, useCtx) => {
        const owner = await composition.serviceToolOwner(slug);
        return owner === undefined ? undefined : await owner.connector.executeSlug!(slug, args, useCtx);
      },
    } : {}),
    // The connect dock's catalog (toolkits with an enabled auth config),
    // annotated per subject from the same cache the connect gate reads.
    list: async (listCtx) => {
      const [connectable, connected] = await Promise.all([
        composition.connections.catalog(),
        composition.connectedToolkitsFor(listCtx).then((toolkits) => new Set(toolkits)),
      ]);
      return connectable.map((entry) => ({
        toolkit: entry.toolkit,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        connected: connected.has(entry.toolkit),
      })) as unknown as Json;
    },
    // The same catalog `list` reads, resolved to ONE row: the ask the agent
    // raises can only name a toolkit this deployment can actually connect, so
    // the card's button always has a broker behind it. `undefined` is the
    // honest answer for anything else — the tool turns it into "check what
    // exists" rather than a dead button.
    connect: async (toolkit) => {
      const entry = (await composition.connections.catalog()).find((candidate) => candidate.toolkit === toolkit);
      return entry === undefined ? undefined : { connector: entry.connector, toolkit: entry.toolkit };
    },
});

/** `deployment_boot`'s three lists: which adapters this deployment is RUNNING,
 *  which optional BLOCKS mounted, and the host framework when its runtime
 *  announces itself. NAMES only — never a URL, a key, or a host identifier.
 *
 *  Every name is read from what the adapter rule SELECTED, never from the slot
 *  the host filled. The two disagree on every Cloud-defaulted seam: a
 *  deployment that passes no `sandbox` and runs the Cloud sandbox is running a
 *  sandbox, and a list built from `config` reports none — an undercount that
 *  looks exactly like a deployment with no sandbox at all. */
const bootShape = (
  composition: VendoComposition,
): { adapters: string[]; blocks: string[]; framework: string | null } => {
  const {
    config, sandbox, connections, resolvedConnectors, knowledgeIndex, appsMounted, automationsMounted,
  } = composition;
  // The knowledge adapter and its prompt index compose together or not at all
  // (composeTools below), so the resolver's presence IS the adapter's.
  const knowledge = knowledgeIndex !== undefined;
  const running = (name: string, live: boolean): string[] => (live ? [name] : []);
  return {
    adapters: [
      // Persistence, blob storage, secrets and the thinker always resolve to
      // something — the local store, the store-backed files adapter, the env
      // provider, the composed `vendo()` harness — so every deployment runs one
      // of each, whether or not it passed one.
      "store",
      "files",
      ...running("sandbox", sandbox.venue !== false),
      "secrets",
      "harness",
      ...running("connections", connections.posture !== false),
      ...running("knowledge", knowledge),
      ...running("connectors", resolvedConnectors.length > 0),
    ],
    blocks: [
      ...(appsMounted ? ["apps"] : []),
      ...(automationsMounted ? ["automations"] : []),
      ...(knowledge ? ["knowledge"] : []),
      ...(config.mcp === undefined || config.mcp === false ? [] : ["mcp"]),
    ],
    // Next sets NEXT_RUNTIME in every server runtime it serves from. No other
    // supported framework announces itself to a RUNNING deployment, so anything
    // else is honestly unknown rather than guessed.
    framework: environment("NEXT_RUNTIME") === undefined ? null : "next",
  };
};

/** One deployment came up. Emitted by `createComposition` once every phase has
 *  run, because that is the first moment the answer exists: the connections
 *  adapter is not chosen until compose-discovery.ts, so a boot event raised
 *  mid-composition could only report the host's config. */
export const emitDeploymentBoot = (composition: VendoComposition): void => {
  emitUsage({ name: "deployment_boot", ...bootShape(composition) });
};

/** The discovery pair, the knowledge tool, and the capability-miss surface. */
export const composeTools = (composition: VendoComposition): Pick<VendoComposition,
  "toolOutputCap" | "catalogConnectors" | "serviceCatalog" | "knowledgeIndex"
  | "missSurface" | "missCapture"> => {
  const { config, actions, store, resolvedConnectors, surfaceRoot } = composition;
  // One value, three readers: the agent's context, the harness bridge, and the
  // discovery registry — which bounds its own search under it rather than being
  // cut by it (the cap slices serialized JSON, so a search that reaches it loses
  // a schema mid-object).
  const toolOutputCap = config.toolOutputCap ?? DEFAULT_TOOL_OUTPUT_CAP;
  // The connector-discovery tools (design 2026-08-03), on the SAME registry, each
  // only as far as an adapter backs it — the "no adapter, no tool" rule knowledge
  // follows below, applied per tool rather than per registry.
  //
  // `list_connections` answers a standalone question ("what can I connect?") and
  // needs nothing but a connector. The CATALOG PAIR needs all THREE halves of the
  // find → use loop from the same connector: only the broker can index tens of
  // thousands of third-party tools (`searchTools`), only it can grade them
  // (`toolRisk`, which is also how a slug is claimed below), and only it can run
  // them (`executeSlug`). Anything less projects a tool the model can see and can
  // never successfully use — there is deliberately no fallback, no keyword scoring
  // (design §Deletions) and no name-based inference (§12, #747). The zero-key Cloud
  // default connector has no search backend, so a Cloud-default host is projected
  // `list_connections` alone rather than a search that answers nothing.
  //
  // The ports read seams declared BELOW this line (`connections`,
  // `connectedToolkitsFor`), the established pattern here: a port body only runs on
  // a real tool call, long after createVendo has returned.
  const catalogConnectors = resolvedConnectors.filter((connector) =>
    connector.searchTools !== undefined
    && connector.toolRisk !== undefined
    && connector.executeSlug !== undefined);
  const serviceCatalog = catalogConnectors.length > 0;
  if (resolvedConnectors.length > 0) {
    actions.add(connectorDiscoveryRegistry(
      connectorDiscoveryPorts(composition, catalogConnectors, serviceCatalog),
      { toolOutputCap },
    ));
  }
  // The user's file drawer, on the SAME registry as everything else — guarded,
  // audited and searchable, with no privileged side door. Unconditional: every
  // deployment has a workspace, so every deployment has a drawer to read.
  //
  // The workspace door is opened LAZILY, for the reason harness-turn.ts opens
  // its own that way: `workspaceStore` wants a backend and throws for a store
  // that offers neither a SQL handle nor StoreOps, and `createVendo` must stay
  // I/O-free at module init (the portability gate). Built from the SAME store
  // and the SAME resolved `files` adapter the harness writes through, so a read
  // and a write can never resolve to different blobs.
  let drawer: ReturnType<typeof workspaceStore> | undefined;
  actions.add(createUserFilesTools(async (principal) =>
    await (drawer ??= workspaceStore(store, { files: composition.files })).open(principal)));

  // Knowledge K1 — the tool exists exactly when an adapter is configured;
  // no adapter, no `vendo_knowledge_search` in any descriptor surface.
  const knowledge = selectKnowledge(config.knowledge, store);
  // K14 — the calibrated band + verifier ride exactly the engine they were
  // calibrated against (the Cloud default); a host-passed adapter keeps the
  // uncalibrated defaults it has today.
  if (knowledge !== undefined) {
    actions.add(createKnowledgeTools(knowledge));
  }
  // Knowledge k8 (ENG-368) — the prompt index rides exactly when the tool
  // composes. Byte-stable at a fixed sync state, refreshed when the sync
  // manifest changes (never rebuilt per-turn); knowledge.json is an
  // ingestion input, not a config surface, so it reads through the raw
  // fail-soft reader like catalog.json.
  const knowledgeIndex = knowledge === undefined
    ? undefined
    : knowledgeIndexResolver(knowledge, {
        readConfig: () => dotVendoFile("knowledge.json", surfaceRoot),
        readManifest: () => dotVendoFile("knowledge-manifest.json", surfaceRoot),
      });
  // #557 — the capability-miss surface is DEFERRED to first use behind a
  // memoized promise. Building it eagerly at compose would call
  // actions.descriptors() → loadHost → the cloud overrides fetch at module
  // init, which Workers forbids in global scope (portability-gate). It resolves
  // ONCE, on the first capability-miss upload or detector report — the same
  // boot-once posture as the enablement provider it now shares loadHost with.
  // (The zero-live-tools warning, emitted inside loadHost, therefore fires on
  // that first request rather than at compose.)
  let missSurfacePromise: Promise<CapabilitySurfaceSnapshot> | undefined;
  const missSurface = (): Promise<CapabilitySurfaceSnapshot> =>
    (missSurfacePromise ??= actions.descriptors()
      .then(capabilitySurfaceSnapshot)
      .catch(() => capabilitySurfaceSnapshot([])));
  // ADAPTER RULE, miss-upload seam: capability-misses.ts never reads the
  // environment for its Cloud uploader — VENDO_API_KEY fills the slot HERE,
  // like the share/publish seam above; unfilled, misses stay local-only.
  const missCloud = cloudKeyOptions();
  const missCapture = createCapabilityMissCapture({
    surface: missSurface,
    ...(missCloud === undefined ? {} : { cloud: missCloud }),
  });
  // Everything Vendo says out loud, and everything it reports about itself,
  // gets its sink here — the same seam and the same Cloud slot the miss stream
  // above rides. A host-passed logger always wins; unset keeps today's console
  // lines byte for byte, with a warn/error ALSO reported as an `sdk_error`.
  setLogger(withSdkErrorReporting(config.logger ?? consoleLogger));
  setUsageSink(createSdkEvents({
    ...(missCloud === undefined ? {} : { cloud: missCloud }),
    runtime: sdkRuntime(),
  })?.record);
  // The boot event itself is raised by `createComposition`, after every phase
  // has run — see emitDeploymentBoot above. The SINK still has to be installed
  // here, before the phases below it can warn.
  return { toolOutputCap, catalogConnectors, serviceCatalog, knowledgeIndex, missSurface, missCapture };
};
