/**
 * The `.vendo` configuration surfaces, resolved into the providers the app
 * writers read: theme, design rules, the merged tool semantics, the pin
 * baselines — plus the ONE capability merge every contributed tool and skill
 * arrives through, and the component catalog.
 */
import { mergedHostSemantics, VENDO_TOOLS_FORMAT } from "@vendoai/actions";
import { agentToolDescriptors, buildingAppsSkill } from "@vendoai/apps";
import {
  log,
  VendoError,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  catalogSummaryEntries,
  type BriefingPack,
  type VendoTheme,
} from "@vendoai/apps/contract";
import {
  hostToolCollision,
  mergeCapability,
  toolsFromRegistry,
  type Contribution,
} from "./capability/index.js";
import {
  mergeRuntimeCatalog,
  normalizeCatalogConfig,
  runtimeCatalogFromFile,
  runtimeCatalogFromJson,
} from "./catalog.js";
import type { VendoComposition } from "./compose-context.js";
import { selectConfigSurface } from "./config-surface.js";
import {
  dotVendoFile,
  dotVendoSeedBaselines,
  hostToolDefinitions,
  hostToolNames,
  parseVendoTheme,
  selectHostTools,
} from "./dot-vendo.js";

/** cse lane 3 — the config surfaces, resolved to the shapes app generation and
 *  the system prompt read them through. */
export const composeSurfaces = (composition: VendoComposition): Pick<VendoComposition,
  "theme" | "themeProvider" | "designRules" | "briefing" | "seedBaselines"
  | "hostSemanticsProvider" | "capability" | "catalog"> => {
  const { config, configCloud, readSurfaceFile, surfaceRoot, memoizeOnce } = composition;
  // Theme surface (cse lane 3, boot-once/next-load STRUCTURAL): explicit config
  // wins; else the in-memory profile piece (Task 15a); else file → cloud. The
  // compose-time `theme` value (config/profile/file only, no cloud) still feeds
  // the wire and the system-prompt catalog summary — they read a value at
  // compose. The cloud-aware boot-once PROVIDER feeds app GENERATION through
  // the apps thunk seam so a console theme publish is honored on the next-load
  // lock without a compose-time fetch.
  const configTheme = config.theme ?? config.profile?.theme;
  const theme = configTheme ?? parseVendoTheme(readSurfaceFile("theme.json"));
  const themeProvider: () => VendoTheme | undefined = configTheme !== undefined
    ? () => configTheme
    : memoizeOnce(() => parseVendoTheme(selectConfigSurface("theme.json", { readFile: readSurfaceFile, cloud: configCloud }).value));
  // App design rules (spec 2026-07-20 + cse lane 3): explicit config wins;
  // otherwise a PER-GENERATION resolution — local file → cloud published value
  // → unset — so both file edits and a console publish apply to the next
  // create/edit without a restart (LIVE, re-resolved every generation).
  // Task 15a: profile.designRules is a convenience alias into this SAME seam —
  // a non-blank apps.designRules wins over it (the longer-standing knob), and
  // a non-blank value from either fixes the rules for the instance lifetime.
  const configDesignRules = config.apps?.designRules?.trim() || config.profile?.designRules?.trim();
  const designRules = configDesignRules
    ? configDesignRules
    : () => selectConfigSurface("design-rules.md", { readFile: readSurfaceFile, cloud: configCloud }).value;
  /**
   * THE briefing pack, and the ONLY place one is assembled (contract §2.5).
   *
   * Everything a writer is told about this product, in one object: the theme
   * verbatim, the host's design rules, `.vendo/brief.md`, the component catalog
   * one line at a time, and the semantics-annotated tool shape card. Both rungs
   * — the screen agent here in the umbrella, and the in-box builder through
   * `AppsConfig.briefing` — render these same bytes. `claudeCode()` is the
   * HARNESS that runs that box, not a builder: the screen agent and its
   * escalation are the one generation brain.
   *
   * Assembled per call, for the reason `designRules` is a provider: the rules
   * re-resolve per generation, and the shape card is projected for THIS caller.
   *
   * `brief` reads the SAME resolution the deployment's own prompt does
   * (`compose-prompt.ts`'s `product` — explicit `instructions`, then the
   * in-memory profile, then `.vendo/brief.md` file → cloud). A second reader of
   * that file is how the two would start to disagree about what the product is.
   * Read lazily because compose-prompt runs after this lane, exactly as the
   * apps-runtime thunk below is.
   */
  const briefing = async (ctx: RunContext): Promise<BriefingPack> => {
    const theme = themeProvider();
    const rules = (typeof designRules === "function" ? designRules() : designRules)?.trim();
    const product = composition.system?.product;
    const brief = (typeof product === "function" ? product() : product)?.trim();
    const appsRuntime = composition.appsRuntime;
    return {
      ...(theme === undefined ? {} : { theme }),
      ...(rules === undefined || rules === "" ? {} : { designRules: rules }),
      ...(brief === undefined || brief === "" ? {} : { brief }),
      catalog: catalogSummaryEntries(composition.catalog),
      ...(config.routes === undefined ? {} : { routes: config.routes }),
      // The one rendering of the shape card there is (`AppsRuntime.toolShapeBrief`).
      // Absent before the apps runtime is composed, which only a boot-time
      // caller could see — every real read happens inside a request.
      hostSemantics: appsRuntime === undefined ? "" : await appsRuntime.toolShapeBrief(ctx),
    };
  };
  const seedBaselines = dotVendoSeedBaselines(config.profileDir);
  // W3 + cse lane 3 — field semantics from the merged .vendo
  // pair (generated tools.json overlaid by overrides.json). The OVERRIDES
  // surface resolves file → cloud; tools.json stays a
  // local generation input (not a cloud surface). Resolved LIVE per generation
  // (NOT memoized) — the apps block's own "re-read per generation" contract:
  // memoizing would lock a local-only merge on a cold cloud snapshot (whenever a
  // local tools.json makes the first merge defined) and drop cloud-owned
  // overrides for the process lifetime (#557 review). A tools.json read +
  // JSON.parse per generation is negligible against generation cost. Malformed
  // → loud + absent, same stance as catalog.json. Task 15a: each in-memory
  // profile piece replaces its file/cloud leg of the merge, per piece.
  const hostSemanticsProvider = (): ReturnType<typeof mergedHostSemantics> => {
    const parsedFile = (name: string): unknown => {
      const raw = dotVendoFile(name, surfaceRoot);
      return raw === undefined ? undefined : JSON.parse(raw) as unknown;
    };
    const overridesRaw = config.profile?.overrides !== undefined
      ? undefined
      : selectConfigSurface("overrides.json", { readFile: readSurfaceFile, cloud: configCloud }).value;
    try {
      return mergedHostSemantics({
        tools: selectHostTools(config) !== undefined
          ? { format: VENDO_TOOLS_FORMAT, tools: selectHostTools(config) }
          : parsedFile("tools.json"),
        // The AI layer's semantics, read live off the same local disk leg as
        // tools.json: judgments.json is not a cloud config surface, and there
        // is no in-memory profile piece for it.
        judgments: parsedFile("judgments.json"),
        overrides: config.profile?.overrides
          ?? (overridesRaw === undefined ? undefined : JSON.parse(overridesRaw) as unknown),
      });
    } catch (error) {
      log({
        code: "vendo.tool-semantics-load-failed",
        level: "error",
        message: `[vendo] Failed to load .vendo tool semantics: ${error instanceof Error ? error.message : String(error)}. Run "vendo sync" to regenerate .vendo/tools.json.`,
      });
      return undefined;
    }
  };
  return {
    theme,
    themeProvider,
    designRules,
    briefing,
    seedBaselines,
    hostSemanticsProvider,
    ...capabilityAndCatalog(composition),
  };
};

/** ONE composition call for everything that contributes tools or skills, and
 *  the component catalog beside it. */
const capabilityAndCatalog = (composition: VendoComposition): Pick<VendoComposition,
  "capability" | "catalog"> => {
  const { config, appsMounted } = composition;
  // ONE composition call for everything that contributes tools or skills. It
  // runs here, before the apps runtime, because the skills it merges reach the
  // harness and the tools it merges reach the one registry. The apps runtime the
  // app tools act through is a THUNK for that reason — composed further down,
  // resolved when a tool actually runs, which is always inside a request.
  const appsAgentTools = (): ToolRegistry => {
    const appsRuntime = composition.appsRuntime;
    if (appsRuntime === undefined) {
      throw new VendoError("not-implemented", "the apps runtime is not composed yet");
    }
    return appsRuntime.agentTools();
  };
  const capability = mergeCapability([
    // App generation mounts itself, through the same two lists a third party
    // gets — there is no privileged internal path, which is the whole point of
    // expressing it this way.
    ...(appsMounted
      ? [{
        from: "app generation",
        tools: toolsFromRegistry(appsAgentTools, agentToolDescriptors),
        skills: [buildingAppsSkill],
      } satisfies Contribution]
      : []),
    // The host's own, last, so a collision message reads in the order the
    // deployment was assembled.
    { from: "createVendo({ tools, skills })", tools: hostToolDefinitions(config), skills: config.skills ?? [] },
  ]);
  // A contributor claiming one of the host's own extracted tool names is a BOOT
  // error, naming both parties: the tool registry would refuse it anyway, but
  // only on some later request and only as "added registry". Compared against the
  // host tool names composition already has in hand — deliberately no I/O, so
  // composing never reaches the network to find out.
  const toolCollision = hostToolCollision(capability.toolOwners, hostToolNames(config));
  if (toolCollision !== undefined) throw toolCollision;
  // Task 15a: an in-memory profile.catalog replaces the DISK leg of the merge
  // (it normalizes through the same validator-building path as the file
  // read); explicit createVendo({ catalog }) registrations still win by name —
  // the host has the last word about its own screens.
  const catalog = mergeRuntimeCatalog(
    config.profile?.catalog !== undefined
      ? runtimeCatalogFromFile(config.profile.catalog, "createVendo({ profile: { catalog } })")
      : runtimeCatalogFromJson(dotVendoFile("catalog.json", config.profileDir)),
    normalizeCatalogConfig(config.catalog),
  );
  return { capability, catalog };
};
