/**
 * The adapter slots, resolved once: persistence, sandbox, secrets, inference,
 * the hosted-config reader, and the `.vendo` surface root every later lazy read
 * resolves against — plus the boot-once readiness latch they all hang off.
 */
import { selectSandbox } from "@vendoai/apps";
import { isGuardInstance } from "@vendoai/guard";
import { bindVendoModelSlots } from "#dev-creds/model";
import { cloudConfig, type CloudConfig } from "./cloud-config.js";
import { cloudKeyOptions, selectSecrets } from "./compose-selection.js";
import type { VendoComposition } from "./compose-context.js";
import { selectStore } from "./compose-store.js";
import type { ConfigSurfaceName } from "./config-surface.js";
import { dotVendoFile, dotVendoRoot } from "./dot-vendo.js";
import { resolveModels } from "./models-config.js";
import { cloudSandbox } from "./sandbox.js";

/* ADAPTER RULE, inference seam: the agent and apps blocks consume one ai-SDK
   LanguageModel; which implementation composes is decided at resolveModels
   (models-config.ts). Precedence per slot: an explicitly passed model object
   always wins (BYO-LLM) → env pin (VENDO_MODEL / VENDO_MODEL_<SLOT>) →
   `models` string → the per-rung default. Every string rides vendoModel()'s
   env ladder, whose rungs live INSIDE it (resolveDevCredential): VENDO_API_KEY
   via @ai-sdk/anthropic pointed at the Cloud model gateway (`<console>/api/v1`
   — Anthropic-compatible /messages), then the honest keyless failure with exact
   instructions on first use. A provider key (ANTHROPIC / OPENAI / GOOGLE) in
   the environment selects NOTHING — the selection law: keys are credentials,
   `models` selects. vendoModel is the one seam-sanctioned lazy env resolver;
   every other adapter still never reads the environment. */

/** 09-vendo §2 — the adapter rule, applied at the one seam that may read the
 *  environment. */
export const composeAdapters = (composition: VendoComposition): Pick<VendoComposition,
  "store" | "files" | "ops" | "sandbox" | "secrets" | "inference" | "configCloud"
  | "surfaceRoot" | "readSurfaceFile" | "memoizeOnce"> => {
  const { config, composed } = composition;
  // Persistence, selected by the adapter rule at this composition seam
  // (selectStore above): explicit store → VENDO_API_KEY hosted store → the
  // local createStore default (02-store §4 re-derived: encryption is
  // production-owned — VENDO_STORE_ENCRYPTION_KEY encrypts at rest; without
  // it dev stores locally unencrypted while production secret writes fail
  // closed).
  const { store, files, ops } = selectStore(
    composed?.store ?? config.store,
    composed?.files ?? config.files,
  );
  // The sandbox seam, resolved by THE ladder — the one in @vendoai/apps that
  // `agent()` calls too (explicit → the Cloud rung → nothing; E2B_API_KEY is a
  // credential for an explicit `e2bSandbox()`, never a rung).
  // "Nothing" is this deployment's dark venue: server apps answer
  // sandbox-unavailable and assertHarnessComposable below refuses a harness
  // that needed a machine.
  const sandbox = selectSandbox(composed?.sandbox ?? config.sandbox, cloudSandbox);
  // Secrets, selected by the adapter rule at this composition seam
  // (selectSecrets above): explicit provider → env chained over the
  // VENDO_API_KEY Cloud provider → env alone. Consumed by machine env
  // building and the apps block (redaction) below.
  const secrets = selectSecrets(config.secrets);
  // Inference, selected by the adapter rule at this composition seam
  // (resolveModels, models-config.ts) — the agent model the agent and apps
  // blocks consume, plus the composed paint knob (family fast pick when the
  // agent slot rides the ladder; the deprecated paint.model otherwise).
  const inference = resolveModels(config);
  // models.judge feeds the judge the host wired from vendoModel("vendo-judge"):
  // the model rides Judge.model, and composition binds THIS instance's config
  // onto exactly that model (bindVendoModelSlots — per createVendo instance,
  // no process-level registry). A custom judge without a model, or a judge
  // built on a BYO model object, is untouched — and there is NO judge default.
  bindVendoModelSlots(
    isGuardInstance(config.guard) ? undefined : config.guard?.judge?.model,
    config.models,
  );
  // cse lane 3 — the Cloud hosted-config adapter, selected at THIS composition
  // seam from VENDO_API_KEY (adapter rule: the surfaces themselves never read
  // the key; cloudKeyOptions lives only here). Constructing it is PURE (closures
  // only, no fetch). It is READ only from LAZY call sites — the block provider
  // seams (design-rules/theme/semantics thunks, the brief resolver, the
  // guard policy fallback, the actions overrides injection) — never at compose,
  // so createVendo stays I/O-free at module init (portability-gate). The
  // snapshot warms on its first (cold) read and revalidates in the background,
  // so a host that resolves no cloud surface makes no config call at all.
  const configCloudOptions = cloudKeyOptions();
  const configCloud: CloudConfig | undefined =
    configCloudOptions === undefined ? undefined : cloudConfig(configCloudOptions);
  // The .vendo surface reader, bound to the pinned compose-time root so the
  // LATER lazy reads (per-generation, per-turn) see the same project every
  // other .vendo input came from (a host that chdirs mid-run). Task 15a: an
  // explicit profileDir wins over the process cwd, so every surface read
  // (theme, design-rules, overrides, brief, policy) resolves under the same
  // root the actions files came from.
  const surfaceRoot = config.profileDir ?? dotVendoRoot();
  const readSurfaceFile = (name: ConfigSurfaceName): string | undefined =>
    dotVendoFile(name, surfaceRoot);
  // Memoize the first DEFINED resolution of a BOOT-ONCE surface (theme,
  // overrides): the surface locks to its first resolved value and never
  // hot-reloads, yet a cold cloud snapshot (warming in the background) still
  // lets a later resolution lock the value in. LIVE surfaces
  // (design-rules/brief) skip this and re-resolve on every read.
  const memoizeOnce = <T>(resolve: () => T | undefined): (() => T | undefined) => {
    let cached: T | undefined;
    let locked = false;
    return () => {
      if (locked) return cached;
      const value = resolve();
      if (value !== undefined) {
        cached = value;
        locked = true;
      }
      return value;
    };
  };
  return {
    store,
    files,
    ops,
    sandbox,
    secrets,
    inference,
    configCloud,
    surfaceRoot,
    readSurfaceFile,
    memoizeOnce,
  };
};

/** The boot-once readiness latch: schema and the background sweep, started
 *  together on the first handler/emit touch. */
export const composeReady = (composition: VendoComposition): Pick<VendoComposition,
  "startBackgroundSweep" | "ready"> => {
  const { store } = composition;
  // Construction stays PURE — no I/O, no timers — because the common edge
  // wiring calls createVendo() at module init, where Workers forbids both
  // (Mohamed's field report: "Disallowed operation called within global
  // scope"). The first handler/emit touch starts schema readiness and the
  // background sweep together through this once-latch; on Node the first
  // request pays the same cost the old eager kick merely front-loaded.
  const startBackgroundSweep: () => void = () => undefined;
  // `composition.startBackgroundSweep` is filled by compose-sweep.ts: it is
  // read on the first touch, never at construction.
  let readyState: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyState === undefined) {
      readyState = store.ensureSchema();
      // No unhandled rejection before a handler/emit awaits the latch.
      void readyState.catch(() => undefined);
      composition.startBackgroundSweep();
    }
    return readyState;
  };
  return { startBackgroundSweep, ready };
};
