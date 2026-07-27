/**
 * Try-mode chrome (product-stage shell, per the approved design canvas
 * variant A + A×): the page paints a deterministic brand-tinted "fake app"
 * backdrop — one of five archetypes picked from the profile's tool domains
 * (try-stage.tsx / pickStageArchetype) — and the agent overlay floats over it
 * ALREADY OPEN, greeting the visitor by product name with the use-case chips
 * inside the panel's empty state (try-panel.tsx). Depth indicator + Refine
 * stay as a quiet top-right cluster over the stage.
 *
 * The slot's data source is decided per render by selectSurfaceMode: when the
 * profile reports liveChat, the surface talks to the real wire at the boot
 * config's apiBase; otherwise the playground's scripted scenario machinery.
 * Both modes mount the SAME open overlay with the same panel landing; a chip
 * press delivers its prompt to the panel's real composer and sends
 * (openVendoConversation), riding whichever transport the mode wired.
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme, type ToolMetaMap } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TryProfile } from "../../try/profile.js";
import { ScenarioMount } from "./scenario-mount.js";
import { scenarios, type PlaygroundScenario } from "./scenarios.js";
import { useGoogleFont } from "./theme-editor.js";
import { decodeThemeParam } from "./theme-state.js";
import {
  brandTitle,
  capabilityLine,
  depthLabel,
  liveToolMeta,
  pickStageArchetype,
  selectSurfaceMode,
  stageGreeting,
  stageNavLabels,
  usecaseChips,
  type TryBoot,
  type TrySurfaceMode,
} from "./try-boot.js";
import { TryPanelProvider, TryPanelThread } from "./try-panel.js";
import { TryRefine, refineEnabled } from "./try-refine.js";
import { TryStage } from "./try-stage.js";
import { LiveSurfaceMount } from "./try-surface-live.js";

/** The profile's theme through the SAME gate as the playground's `?theme=`
 *  (partials resolve over the shipped defaults, garbage is dropped). */
function profileTheme(profile: TryProfile | null): VendoTheme {
  const raw = profile?.theme;
  return (raw ? decodeThemeParam(JSON.stringify(raw)) : undefined) ?? defaultVendoTheme;
}

/** Page-level styling the shell owns: the panel chips render through the
 *  thread's composerAccessory seam, which mounts in BOTH layouts — this keeps
 *  them to the landing (the canvas only puts chips in the empty state). And
 *  the canvas never shows the launcher pill behind the open overlay's scrim,
 *  so it hides while open (aria-expanded is the chrome's own open state) and
 *  returns on close — focus restoration already skips non-visible targets. */
const TRY_SHELL_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; }
.fl-chips[data-vendo-try-chips] { display: none; }
.fl-landing .fl-chips[data-vendo-try-chips] { display: flex; }
.fl-launcher[aria-expanded="true"] { display: none; }
`;

/** The scripted stance: the overlay-open scenario's script and fixtures, but
 *  rendered as the try panel — open at boot, greet + chips inside, NO
 *  auto-sent turn (the visitor starts the conversation, usually via a chip).
 *  Module-scoped so the surface never remounts on store updates. */
const stageScenario: PlaygroundScenario = {
  ...(scenarios.find((entry) => entry.id === "overlay-open") ?? scenarios[0]!),
  id: "try-stage",
  autoSend: undefined,
  render: () => <VendoOverlay defaultOpen discoverability="quiet" thread={TryPanelThread} />,
};

/** The ONE swappable surface slot. Live mode (profile reports liveChat) is
 *  the same overlay chrome on the REAL wire at `apiBase`; scripted mode is
 *  the scenario-mount machinery. Both stances match: the overlay opens at
 *  boot on the panel landing; there is NO runtime fallback between them. */
function TrySurface({ mode, apiBase, theme, tools }: {
  mode: TrySurfaceMode;
  apiBase: string;
  theme: VendoTheme;
  tools: ToolMetaMap;
}) {
  if (mode === "live") {
    return <LiveSurfaceMount apiBase={apiBase} theme={theme} tools={tools} />;
  }
  return <ScenarioMount scenario={stageScenario} theme={theme} />;
}

export function TryApp({ boot }: { boot: TryBoot }) {
  const state = useSyncExternalStore(boot.subscribe, () => boot.state);
  const theme = profileTheme(state.profile);
  useGoogleFont(theme.typography.fontFamily);
  const label = depthLabel(state.profile, state.stages);
  // The stage + panel content, re-derived on every store update: a deepening
  // run landing the seeds artifact swaps the chips live (context, so the
  // panel's thread — and any conversation on it — never remounts), and a
  // theme/brief refetch re-tints the stage in place.
  const archetype = pickStageArchetype(state.profile);
  const brandName = brandTitle(state.profile);
  const logoUrl = state.profile?.brand?.logoUrl ?? null;
  const navLabels = stageNavLabels(archetype, state.profile);
  const panelContent = useMemo(
    () => ({
      greeting: stageGreeting(state.profile),
      intro: capabilityLine(archetype, state.profile),
      chips: usecaseChips(state.profile),
    }),
    [state.profile, archetype],
  );
  const mode = selectSurfaceMode(state.profile);
  const tools = useMemo(() => liveToolMeta(state.profile), [state.profile]);

  // Unmount hygiene: the boot store dies with the app (this root lives for
  // the page today, but nothing should rely on that). Teardown-without-setup
  // is safe here: the CLI serves a production React bundle, so StrictMode's
  // dev-only effect double-invoke never fires this early.
  useEffect(() => () => boot.close(), [boot]);

  // The page IS the stage: the archetype backdrop wears the profile theme
  // edge to edge; the overlay (open at boot) floats over it with the chrome's
  // own scrim + blur — the canvas treatment, no extra chrome here.
  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.colors.background,
        color: theme.colors.text,
        fontFamily: theme.typography.fontFamily,
      }}
    >
      <style>{TRY_SHELL_CSS}</style>
      <TryStage
        archetype={archetype}
        theme={theme}
        brandName={brandName}
        logoUrl={logoUrl}
        navLabels={navLabels}
      />
      {/* The shell's own controls, quiet in the header region per the canvas:
          the live depth indicator and (server capability permitting) Refine.
          Fixed above the stage; while the overlay is open they sit under its
          scrim like the rest of the page, and come back on close. */}
      <div style={{ position: "fixed", top: 12, right: 16, zIndex: 20, display: "flex", alignItems: "center", gap: 10 }}>
        {label ? (
          <span
            aria-live="polite"
            style={{
              fontSize: 12,
              color: theme.colors.muted,
              background: theme.colors.surface,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 999,
              padding: "6px 12px",
            }}
          >
            {label}
          </span>
        ) : null}
        {/* Only rendered when the server reports the capability: a keyless
            run never shows a Refine affordance it couldn't honor. */}
        {refineEnabled(state.profile) ? <TryRefine theme={theme} /> : null}
      </div>
      {/* Keyed by mode: a mode flip (server-reported, never a client-side
          fallback) must remount onto the other data source cleanly. */}
      <TryPanelProvider content={panelContent}>
        <TrySurface key={mode} mode={mode} apiBase={boot.config.apiBase} theme={theme} tools={tools} />
      </TryPanelProvider>
    </div>
  );
}
