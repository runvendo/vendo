/**
 * The shared scenario harness: one REAL chrome surface mounted against the
 * fake wire client + scripted transport. Used by the playground page
 * (main.tsx) and the docs inline embeds (embed-entry.tsx).
 */
import type { VendoTheme } from "@vendoai/core";
import { ScriptedTransport, VendoProvider } from "@vendoai/ui";
import { useEffect, useMemo } from "react";
import { createFakeClient } from "./fake-client.js";
import { playgroundFixtures, playgroundToolMeta } from "./fixtures.js";
import type { PlaygroundScenario } from "./scenarios.js";

/**
 * Types the scenario's opening turn into the mounted chrome's own composer and
 * submits it — the send travels the REAL path (draft state, user bubble,
 * transport). Scoped to `root` first so several embeds on one page each drive
 * their own composer; falls back to the document for surfaces that portal to
 * the body (the overlay). Retries briefly while the surface mounts.
 */
function useAutoSend(scenario: PlaygroundScenario, root?: HTMLElement): void {
  useEffect(() => {
    const prompt = scenario.autoSend;
    if (!prompt) return;
    let tries = 0;
    let submitTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const scope: ParentNode = root ?? document;
      const textarea =
        scope.querySelector<HTMLTextAreaElement>("form.fl-composer textarea") ??
        (root ? document.querySelector<HTMLTextAreaElement>("form.fl-composer textarea") : null);
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
  }, [scenario, root]);
}

export function ScenarioMount({ scenario, theme, root }: {
  scenario: PlaygroundScenario;
  theme: VendoTheme;
  /** The embed container, when mounted inline in a host page (docs). */
  root?: HTMLElement;
}) {
  const client = useMemo(() => createFakeClient((scenario.fixtures ?? playgroundFixtures)()), [scenario]);
  const transport = useMemo(
    () => (scenario.script ? new ScriptedTransport(scenario.script, { speed: scenario.speed ?? 1 }) : undefined),
    [scenario],
  );
  useAutoSend(scenario, root);
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
