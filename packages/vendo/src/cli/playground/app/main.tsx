/**
 * The playground page: a scenario nav on the left, one REAL chrome surface on
 * the right, everything driven by the scripted transport + fake wire client.
 * Each scenario is one URL (`#<id>`); `?embed=1` renders the surface alone
 * (used by the phone-viewport iframe).
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme, ScriptedTransport, VendoProvider } from "@vendoai/ui";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createFakeClient } from "./fake-client.js";
import { playgroundFixtures, playgroundToolMeta } from "./fixtures.js";
import { scenarios, type PlaygroundScenario } from "./scenarios.js";
import { ThemeEditor, useGoogleFont } from "./theme-editor.js";
import { decodeThemeParam, encodeThemeParam } from "./theme-state.js";

const SHELL_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, system-ui, -apple-system, sans-serif; background: #f3ede2; color: #14151a; }
  .pg-shell { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }
  .pg-nav { border-right: 1px solid #e3ddd2; background: #faf6ee; padding: 18px 14px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .pg-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; margin: 4px 6px 2px; }
  .pg-brand small { display: block; font-weight: 500; font-size: 11px; color: #8a8b92; margin-top: 3px; }
  .pg-group { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; color: #8a8b92; margin: 18px 6px 6px; }
  .pg-link { display: block; padding: 7px 10px; border-radius: 8px; font-size: 13px; color: #34353b; text-decoration: none; }
  .pg-link:hover { background: #f0e9dc; }
  .pg-link[aria-current="page"] { background: #14151a; color: #fffdf9; }
  .pg-main { padding: 26px 30px 60px; min-width: 0; }
  @media (max-width: 640px) {
    .pg-shell { grid-template-columns: 1fr; }
    .pg-nav { position: static; height: auto; border-right: none; border-bottom: 1px solid #e3ddd2; }
    .pg-main { padding: 18px 16px 80px; }
  }
  .pg-head { max-width: 860px; margin-bottom: 20px; }
  .pg-head h1 { font-size: 19px; letter-spacing: -0.01em; margin: 0 0 6px; }
  .pg-head p { font-size: 13.5px; color: #5c5d64; line-height: 1.55; margin: 0; }
  .pg-stage { max-width: 860px; }
  .pg-embed { padding: 0; }
`;

/**
 * Types the scenario's opening turn into the mounted chrome's own composer and
 * submits it — the send travels the REAL path (draft state, user bubble,
 * transport). The composer may live in a body-level portal (the overlay), so
 * the search spans the document, retrying briefly while the surface mounts.
 */
function useAutoSend(scenario: PlaygroundScenario): void {
  useEffect(() => {
    const prompt = scenario.autoSend;
    if (!prompt) return;
    let tries = 0;
    let submitTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>("form.fl-composer textarea");
      const form = textarea?.closest("form");
      if (textarea && form) {
        clearInterval(timer);
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, prompt);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        // Let React commit the draft before the submit reads it.
        submitTimer = setTimeout(() => form.requestSubmit(), 120);
      } else if ((tries += 1) > 50) {
        clearInterval(timer);
      }
    }, 100);
    return () => {
      clearInterval(timer);
      clearTimeout(submitTimer);
    };
  }, [scenario]);
}

function ScenarioMount({ scenario, theme }: { scenario: PlaygroundScenario; theme: VendoTheme }) {
  const client = useMemo(() => createFakeClient((scenario.fixtures ?? playgroundFixtures)()), [scenario]);
  const transport = useMemo(
    () => (scenario.script ? new ScriptedTransport(scenario.script, { speed: scenario.speed ?? 1 }) : undefined),
    [scenario],
  );
  useAutoSend(scenario);
  return (
    <VendoProvider
      client={client}
      transport={transport}
      theme={theme}
      tools={playgroundToolMeta}
      connectors={[{ toolkit: "slack", label: "Slack" }, { toolkit: "github", label: "GitHub" }]}
    >
      {scenario.render()}
    </VendoProvider>
  );
}

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
      <div className="pg-embed">
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
          Vendo playground
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
      <main className="pg-main">
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
