/**
 * The playground page: a scenario nav on the left, one REAL chrome surface on
 * the right, everything driven by the scripted transport + fake wire client.
 * Each scenario is one URL (`#<id>`); `?embed=1` renders the surface alone
 * (used by the phone-viewport iframe).
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme } from "@vendoai/ui";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScenarioMount } from "./scenario-mount.js";
import { scenarios, type PlaygroundScenario } from "./scenarios.js";
import { ThemeEditor, useGoogleFont } from "./theme-editor.js";
import { decodeThemeParam, encodeThemeParam } from "./theme-state.js";

/* Vendo brand shell (brand kit): Porcelain #FAFAF8, Ink #17171A, Ultramarine
   #4338CA, Onest (its @font-face rides in via the chrome stylesheet). The
   STAGE column deliberately has no fixed background — App paints it with the
   active theme's colors.background so every chrome surface sits on its own
   canvas edge-to-edge instead of printing an abrupt theme-colored rectangle
   on the shell. */
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

function App() {
  const scenario = useHashScenario();
  const embed = new URLSearchParams(window.location.search).has("embed");
  const [theme, setTheme] = useThemeState(embed);

  if (embed) {
    return (
      // Same host-canvas rule as the stage: the embed page (the phone iframe's
      // whole viewport) wears the theme background so the surface blends.
      <div className="pg-embed" style={{ background: theme.colors.background, minHeight: "100vh" }}>
        {/* keyed: a scenario switch must remount the chrome + fresh transport */}
        <ScenarioMount key={scenario.id} scenario={scenario} theme={theme} />
      </div>
    );
  }

  const groups = [...new Set(scenarios.map((entry) => entry.group))];
  return (
    <div className="pg-shell">
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

const style = document.createElement("style");
style.textContent = SHELL_CSS;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
