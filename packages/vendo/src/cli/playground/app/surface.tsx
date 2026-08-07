/**
 * The try surface, as an importable client-only module.
 *
 * This is the ONE source both venues build from: vendo-web's Next client route
 * (`@vendoai/vendo/try-surface`) and the docs inline-embed IIFE
 * (`embed-entry.tsx`). It carries NO module-level DOM/window access
 * so it is safe to import under SSR — every `document`/`window` touch lives
 * inside `mount()` or a component effect, which only ever run in the browser.
 *
 * Public shape:
 *   mount(el, options?)      — boot the surface (playground OR try) into `el`
 *   <PlaygroundApp/>         — the scripted playground shell (self-contained CSS)
 *   <TrySurface config=…/>   — the hosted try surface (async boot, classic
 *                              fallback), config-driven for a Next route
 *   mountScenario / mountLauncher — the docs inline-embed drop-ins
 *
 * The import closure is asserted client-only by closure-guard (Task 2): only
 * @vendoai/ui, @vendoai/core, react, ai, and this app's own files — never the
 * umbrella server graph.
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme } from "@vendoai/ui";
import { StrictMode, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ScenarioMount } from "./scenario-mount.js";
import { scenarios, type PlaygroundScenario } from "./scenarios.js";
import { ThemeEditor, useGoogleFont } from "./theme-editor.js";
import { decodeThemeParam, encodeThemeParam } from "./theme-state.js";
import { TryApp } from "./try-app.js";
import { createTryBoot, readTryConfig, type TryBoot, type TryBootConfig } from "./try-boot.js";

/* Vendo brand shell (brand kit): Porcelain #FAFAF8, Ink #17171A, Ultramarine
   #4338CA, Onest (its @font-face rides in via the chrome stylesheet). The
   STAGE column deliberately has no fixed background — App paints it with the
   active theme's colors.background so every chrome surface sits on its own
   canvas edge-to-edge instead of printing an abrupt theme-colored rectangle
   on the shell. Rendered as a <style> at the shell root so the component is
   self-contained (a Next route needs no separate CSS injection). */
const SHELL_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Onest, Inter, system-ui, -apple-system, sans-serif; background: #fafaf8; color: #17171a; }
  .pg-shell { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }
  .pg-nav { border-right: 1px solid rgba(23, 23, 26, 0.08); background: #fafaf8; padding: 18px 14px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .pg-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; margin: 4px 6px 2px; }
  .pg-brand-mark { color: #4338ca; }
  .pg-brand small { display: block; font-weight: 500; font-size: 11px; color: #6f6f78; margin-top: 3px; }
  .pg-group { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; color: #85858f; margin: 18px 6px 6px; }
  .pg-link { display: block; padding: 7px 10px; border-radius: 8px; font-size: 13px; color: #3a3a41; text-decoration: none; transition: background .12s, color .12s; }
  .pg-link:hover { background: rgba(67, 56, 202, 0.07); color: #17171a; }
  .pg-link[aria-current="page"] { background: #17171a; color: #fafaf8; }
  .pg-main { padding: 26px 30px 60px; min-width: 0; transition: background .2s, color .2s; }
  @media (max-width: 640px) {
    .pg-shell { grid-template-columns: 1fr; }
    .pg-nav { position: static; height: auto; border-right: none; border-bottom: 1px solid rgba(23, 23, 26, 0.08); }
    .pg-main { padding: 18px 16px 80px; }
  }
  .pg-head { max-width: 860px; margin-bottom: 20px; }
  .pg-head h1 { font-size: 19px; letter-spacing: -0.01em; margin: 0 0 6px; }
  .pg-head p { font-size: 13.5px; opacity: 0.72; line-height: 1.55; margin: 0; }
  .pg-stage { max-width: 860px; }
  .pg-embed { padding: 0; }
`;

const THEME_MESSAGE = "vendo-playground-theme";
const THEME_REQUEST = "vendo-playground-theme-request";

/** Validate a postMessage payload through the same gate as the URL param. */
function themeFromMessage(data: unknown): VendoTheme | undefined {
  const message = data as { type?: unknown; theme?: unknown } | null;
  if (!message || message.type !== THEME_MESSAGE) return undefined;
  return decodeThemeParam(JSON.stringify(message.theme));
}

/** Shared theme state: seeded from `?theme=`, written back to the URL (so
 * links share the look), and mirrored into embed iframes via postMessage so
 * the phone-viewport scenario re-themes live without reloading. */
function useThemeState(embed: boolean): [VendoTheme, (next: VendoTheme) => void] {
  const [theme, setTheme] = useState<VendoTheme>(
    () => decodeThemeParam(new URLSearchParams(window.location.search).get("theme")) ?? defaultVendoTheme,
  );
  useGoogleFont(theme.typography.fontFamily);

  useEffect(() => {
    if (embed) return;
    const params = new URLSearchParams(window.location.search);
    if (theme === defaultVendoTheme) params.delete("theme");
    else params.set("theme", encodeThemeParam(theme));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    for (const frame of document.querySelectorAll("iframe")) {
      frame.contentWindow?.postMessage({ type: THEME_MESSAGE, theme }, "*");
    }
  }, [embed, theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (embed) {
        const next = themeFromMessage(event.data);
        if (next) setTheme(next);
        return;
      }
      // An embed iframe finished mounting and wants the current state.
      if ((event.data as { type?: unknown } | null)?.type === THEME_REQUEST && event.source) {
        (event.source as Window).postMessage({ type: THEME_MESSAGE, theme }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embed, theme]);

  useEffect(() => {
    if (embed && window.parent !== window) window.parent.postMessage({ type: THEME_REQUEST }, "*");
  }, [embed]);

  return [theme, setTheme];
}

function useHashScenario(): PlaygroundScenario {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return scenarios.find((scenario) => scenario.id === hash) ?? scenarios[0]!;
}

/**
 * The scripted playground shell: a scenario nav on the left, one REAL chrome
 * surface on the right, everything driven by the scripted transport + fake wire
 * client. Each scenario is one URL (`#<id>`); `?embed=1` renders the surface
 * alone (used by the phone-viewport iframe). Self-contained: it renders its own
 * shell CSS, so a Next route can drop it in with no extra plumbing.
 */
export function PlaygroundApp(): ReactElement {
  const scenario = useHashScenario();
  const embed = new URLSearchParams(window.location.search).has("embed");
  const [theme, setTheme] = useThemeState(embed);

  if (embed) {
    return (
      // Same host-canvas rule as the stage: the embed page (the phone iframe's
      // whole viewport) wears the theme background so the surface blends.
      <div className="pg-embed" style={{ background: theme.colors.background, minHeight: "100vh" }}>
        <style>{SHELL_CSS}</style>
        {/* keyed: a scenario switch must remount the chrome + fresh transport */}
        <ScenarioMount key={scenario.id} scenario={scenario} theme={theme} />
      </div>
    );
  }

  const groups = [...new Set(scenarios.map((entry) => entry.group))];
  return (
    <div className="pg-shell">
      <style>{SHELL_CSS}</style>
      <nav className="pg-nav" aria-label="Scenarios">
        <div className="pg-brand">
          <span className="pg-brand-mark">vendo</span> playground
          <small>every surface · scripted data · no model key</small>
        </div>
        {groups.map((group) => (
          <div key={group}>
            <div className="pg-group">{group}</div>
            {scenarios
              .filter((entry) => entry.group === group)
              .map((entry) => (
                <a
                  key={entry.id}
                  className="pg-link"
                  href={`#${entry.id}`}
                  aria-current={entry.id === scenario.id ? "page" : undefined}
                >
                  {entry.title}
                </a>
              ))}
          </div>
        ))}
      </nav>
      {/* The stage is the "host page": it wears the ACTIVE theme's background
          and text color, so surfaces (whose ChromeRoot paints that same
          background) blend seamlessly under any theme-editor theme. */}
      <main className="pg-main" style={{ background: theme.colors.background, color: theme.colors.text }}>
        <header className="pg-head">
          <h1>{scenario.title}</h1>
          <p>{scenario.description}</p>
        </header>
        <div className="pg-stage">
          <ScenarioMount key={scenario.id} scenario={scenario} theme={theme} />
        </div>
      </main>
      <ThemeEditor theme={theme} onChange={setTheme} />
    </div>
  );
}

/**
 * The hosted try surface (the console's try venue): boots the try
 * profile from `config`, then renders the product stage + open overlay. The
 * FIRST paint blocks only on the initial profile load (the server answers from
 * disk — never an AI wait, so the latency law holds); a hard load failure hands
 * the page to the scripted playground.
 */
export function TrySurface({ config }: { config: TryBootConfig }): ReactElement | null {
  const [boot, setBoot] = useState<TryBoot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const pending = createTryBoot({
      config,
      fetchImpl: (url) => fetch(url),
      eventSourceFactory: (url) => new EventSource(url),
    });
    let alive = true;
    void pending.load().then(({ ok }) => {
      if (!alive) {
        pending.close();
        return;
      }
      if (ok) setBoot(pending);
      else {
        pending.close();
        setFailed(true);
      }
    });
    return () => {
      alive = false;
      pending.close();
    };
  }, [config]);

  if (failed) return <PlaygroundApp />;
  if (!boot) return null; // pre-load: blank, no AI gate — first real paint is the stage
  return <TryApp boot={boot} />;
}

export interface MountOptions {
  /**
   * The try-mode boot pointer. When omitted, it is read from
   * `window.__VENDO_TRY__` (a host page's injection); pass `null` to force the
   * scripted playground, or a config to force try mode (a Next route that owns
   * its own config).
   */
  tryConfig?: TryBootConfig | null;
}

/**
 * Boot the surface into `el` and return a disposer. Try mode boots from
 * `window.__VENDO_TRY__`; any page without one — the playground server,
 * `?embed=1` iframes, hash-routed scenarios — is the classic scripted
 * playground. A failed profile load falls back to classic too.
 */
export function mount(el: HTMLElement, options: MountOptions = {}): () => void {
  const config = options.tryConfig !== undefined ? options.tryConfig : readTryConfig(window);
  const root = createRoot(el);
  root.render(
    <StrictMode>{config === null ? <PlaygroundApp /> : <TrySurface config={config} />}</StrictMode>,
  );
  return () => root.unmount();
}

export interface EmbedMountOptions {
  /** Scenario id from the playground registry (e.g. "approval-flow"). */
  scenario: string;
  /** Optional encoded theme (the playground's ?theme= format). */
  theme?: string;
}

/**
 * The docs inline-embed drop-in: mount ONE real chrome surface (scripted data,
 * no model key) directly into a host page's DOM. Returns a disposer.
 */
export function mountScenario(el: HTMLElement, options: EmbedMountOptions): () => void {
  const scenario = scenarios.find((entry) => entry.id === options.scenario);
  if (!scenario) {
    const known = scenarios.map((entry) => entry.id).join(", ");
    throw new Error(`[vendo-embed] unknown scenario "${options.scenario}" — one of: ${known}`);
  }
  const theme = decodeThemeParam(options.theme ?? null) ?? defaultVendoTheme;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <ScenarioMount scenario={scenario} theme={theme} root={el} />
    </StrictMode>,
  );
  return () => root.unmount();
}

/** The real product drop-in: corner launcher pill + overlay, scripted data. */
export function mountLauncher(options: { theme?: string } = {}): () => void {
  const host = document.createElement("div");
  host.dataset.vendoDocsLauncher = "";
  document.body.append(host);
  const dispose = mountScenario(host, { scenario: "overlay-launcher", theme: options.theme });
  return () => {
    dispose();
    host.remove();
  };
}
