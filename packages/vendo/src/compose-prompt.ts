/**
 * What the ONE thinker is told, and how it finds the rest.
 *
 * The system-prompt inputs (03 §3's one prose story, the theme line, the
 * knowledge index) and the two discovery rails were written twice — once for a
 * `createAgent` that no longer exists, once for the harness runtime. They are
 * defined ONCE here and handed to the runtime below.
 *
 * The host COMPONENT list is no longer one of them: this thinker renders nothing,
 * and what a writer is told about the host's components is the briefing pack
 * (`contract/briefing.ts`), which is now the only rendering of that list there is.
 * The theme LINE stays — the pack hands the screen agent the tokens verbatim, so
 * a sentence about the brand here is a different thing for a different reader,
 * not a second copy.
 */
import type { CapabilityMissConfig } from "@vendoai/harnesses";
import type { VendoToolSearchConfig } from "@vendoai/harnesses/vendo";
import { themeSummary } from "@vendoai/apps/contract";
import type { CloudConfig } from "./cloud-config.js";
import type { VendoComposition } from "./compose-context.js";
import { selectConfigSurface } from "./config-surface.js";

/** The prompt inputs and the discovery rails, for the one thinker. */
export const composePrompt = (composition: VendoComposition): Pick<VendoComposition,
  "system" | "capabilityMiss" | "toolSearch"> => {
  const { config, composed, configCloud, readSurfaceFile } = composition;
  const { theme, knowledgeIndex, missSurface, missCapture, actions } = composition;
  // AGENT-1/2 — 03 §3: ONE prose story. `instructions` and the
  // `.vendo/brief.md` surface behind it are the deployment's own words about
  // what this product is and how to speak about it; prompt.ts places them as the
  // Product section. `brief:` and `agent.instructions` were two names for this
  // and are gone.
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
  const promptTheme = themeSummary(theme);
  const system = product !== undefined || promptTheme !== undefined || knowledgeIndex !== undefined
    ? {
        ...(product === undefined ? {} : { product }),
        ...(promptTheme === undefined ? {} : { theme: promptTheme }),
        ...(knowledgeIndex === undefined ? {} : { knowledge: knowledgeIndex }),
      }
    : undefined;
  // The honest-refusal rail, defined once for the one thinker: the harness
  // runtime lists the reporter beside the projected tools.
  const capabilityMiss: CapabilityMissConfig = {
    hostId: missCapture.hostId,
    surface: () => missSurface().then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
    emit: (event) => missCapture.record(event),
  };
  // ENG-252, de-brained: `vendo()` starts with a bounded loadout and discovers
  // the rest through its own `find_tools` hand — this is the strategy config
  // composition hands it (compose-harness.ts / the adapter slot). The search
  // seam is the registry's own scorer; a match only becomes CALLABLE through
  // the projected, menu-bound listing (`withAgentMenu` on the harness door's
  // registry handle), so search has no path back to an off-menu or withheld
  // tool. No connect-required annotation any more (deliberate cut): the
  // connect card at call time is the flow that actually converts.
  const toolSearch: VendoToolSearchConfig = {
    search: async (query, options) => actions.search(query, options),
    ...(config.maxInitialTools === undefined ? {} : { maxInitialTools: config.maxInitialTools }),
    ...(config.loadout === undefined ? {} : { loadout: [...config.loadout] }),
  };
  return { system, capabilityMiss, toolSearch };
};
