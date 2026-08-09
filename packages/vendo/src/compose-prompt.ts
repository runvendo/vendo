/**
 * What the ONE thinker is told, and how it finds the rest.
 *
 * The system-prompt inputs (03 §3's one prose story, the catalog+theme summary,
 * the knowledge index) and the two discovery rails were written twice — once for
 * a `createAgent` that no longer exists, once for the harness runtime. They are
 * defined ONCE here and handed to the runtime below.
 */
import type { CapabilityMissConfig, ToolSearchConfig } from "@vendoai/harnesses";
import { catalogThemeSummary } from "./catalog.js";
import type { CloudConfig } from "./cloud-config.js";
import type { VendoComposition } from "./compose-context.js";
import { selectConfigSurface } from "./config-surface.js";

/** The prompt inputs and the discovery rails, for the one thinker. */
export const composePrompt = (composition: VendoComposition): Pick<VendoComposition,
  "system" | "capabilityMiss" | "toolSearch"> => {
  const { config, composed, configCloud, readSurfaceFile } = composition;
  const { catalog, theme, knowledgeIndex, missSurface, missCapture, actions } = composition;
  // AGENT-1/2 — 03 §3: ONE prose story. `instructions` and the
  // `.vendo/brief.md` surface behind it are the deployment's own words about
  // what this product is and how to speak about it; prompt.ts places them (the
  // Product section) beside the catalog+theme summary (only where trees
  // render). `brief:` and `agent.instructions` were two names for this and are
  // gone.
  // cse lane 3 — a prompt-family surface, so it resolves LIVE: with a key
  // present, product is a RESOLVER (file → cloud) re-read per turn by
  // assembleSystemPrompt, so a console publish applies to the next turn with no
  // restart. Without a key, product is the compose-time file/explicit value (no
  // snapshot read → no I/O at compose). Programmatic `instructions` wins over
  // the file either way; an adopted agent's own `instructions` is the same slot
  // (AGENT_OWNED_KEYS refuses both at once). Task 15a: the in-memory
  // profile.brief sits between them — below the explicit knob, above the
  // file/cloud surface — and an explicitly empty one means "no brief" (it never
  // falls through to disk).
  const resolveInstructions = (cloud?: CloudConfig): string | undefined => {
    const explicit = (config.instructions ?? composed?.instructions)?.trim();
    if (explicit) return explicit;
    if (config.profile?.brief !== undefined) return config.profile.brief.trim() || undefined;
    return selectConfigSurface("brief.md", {
      readFile: readSurfaceFile,
      ...(cloud === undefined ? {} : { cloud }),
    }).value?.trim() || undefined;
  };
  const product: string | (() => string | undefined) | undefined = configCloud === undefined
    ? resolveInstructions()
    : () => resolveInstructions(configCloud);
  const promptCatalog = catalogThemeSummary(catalog, theme);
  const system = product !== undefined || promptCatalog !== undefined || knowledgeIndex !== undefined
    ? {
        ...(product === undefined ? {} : { product }),
        ...(promptCatalog === undefined ? {} : { catalog: promptCatalog }),
        ...(knowledgeIndex === undefined ? {} : { knowledge: knowledgeIndex }),
      }
    : undefined;
  // ONE definition of each discovery rail, for the one thinker: the harness
  // runtime. They were written twice — once here for `createAgent`, once for the
  // runtime — and a rail that existed on one path and not the other is exactly
  // why `POST /threads` could not be pointed at the harness for so long.
  const capabilityMiss: CapabilityMissConfig = {
    hostId: missCapture.hostId,
    surface: () => missSurface().then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
    emit: (event) => missCapture.record(event),
  };
  // ENG-252: the agent starts with a bounded loadout and discovers the rest via
  // `find_tools`. The search seam is the SAME guard-bound registry the
  // agent executes through — a searched-in tool has no unguarded path.
  const toolSearch: ToolSearchConfig = {
    // Annotate results the subject cannot run yet. The tool description and the
    // system prompt both promise this, and the connect-card flow depends on it;
    // same predicate the connect gate executes against, so the annotation and
    // the refusal can never disagree.
    connectRequired: async (toolkit, toolkitCtx) => !(await composition.subjectHasToolkit(toolkit, toolkitCtx)),
    // A curated agent menu has to hold at BOTH doors into the toolset: the
    // per-turn seed below and search. Filtering only the seed would let the
    // model search its way back to an off-menu tool.
    search: async (query, options) => composition.onAgentMenu(
      await actions.search(query, options),
      (match) => match.name,
    ),
    // Connection-scoped loadout seed (spec 2026-07-20): each turn starts
    // with host tools + the principal's connected toolkits — never an
    // alphabetical slice of a lazy catalog. `connections` is declared below
    // this composition; turns only run after createVendo returns, so the
    // closure reference is safe.
    seed: () => composition.loadoutSeedFor(),
    // The curated agent menu also binds an explicit `loadout`: host config
    // chooses WITHIN the menu, it does not escape it.
    menu: async () => {
      const menu = await composition.agentMenu();
      return menu === undefined ? undefined : [...menu];
    },
    ...(config.maxInitialTools === undefined ? {} : { maxInitialTools: config.maxInitialTools }),
    ...(config.loadout === undefined ? {} : { loadout: [...config.loadout] }),
  };
  return { system, capabilityMiss, toolSearch };
};
