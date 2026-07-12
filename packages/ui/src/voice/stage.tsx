import { type CSSProperties } from "react";
import { ChromeRoot } from "../chrome/chrome-root.js";
import type { VoiceState } from "./driver.js";
import { useVoice } from "./use-voice.js";

const ACTIVE_STATES = new Set<VoiceState>(["connecting", "listening", "speaking"]);

/** The accessible, theme-adopting voice surface (08-ui §4). */
export function VendoStage() {
  const { state, start, stop, transcript } = useVoice();
  const active = ACTIVE_STATES.has(state);
  const rootStyle = {
    display: "grid",
    gap: "calc(var(--vendo-font-size) * 0.75)",
    padding: "var(--vendo-font-size)",
    color: "var(--vendo-color-text)",
    background: "var(--vendo-color-surface)",
    fontFamily: "var(--vendo-font-family)",
    fontSize: "var(--vendo-font-size)",
    borderRadius: "var(--vendo-radius-large)",
  } as CSSProperties;

  return (
    <ChromeRoot>
      <section aria-label="Voice" style={rootStyle}>
      <button
        type="button"
        aria-pressed={active}
        disabled={state === "unavailable"}
        onClick={active ? stop : start}
        style={{
          color: "var(--vendo-color-accent-text)",
          background: "var(--vendo-color-accent)",
          border: "none",
          borderRadius: "var(--vendo-radius-medium)",
          padding: "calc(var(--vendo-font-size) * 0.65) var(--vendo-font-size)",
          font: "inherit",
          cursor: state === "unavailable" ? "not-allowed" : "pointer",
        }}
      >
        {active ? "Stop voice" : "Start voice"}
      </button>

      <div role="status" aria-live="polite" style={{ color: "var(--vendo-color-muted)" }}>
        Voice: {state}
      </div>

      <ol
        aria-label="Voice transcript"
        aria-live="polite"
        style={{
          display: "grid",
          gap: "calc(var(--vendo-font-size) * 0.5)",
          padding: "unset",
          margin: "unset",
          listStyle: "none",
        }}
      >
        {transcript.map((entry) => (
          <li
            key={entry.id}
            data-final={entry.final}
            style={{
              color: entry.role === "user" ? "var(--vendo-color-accent)" : "var(--vendo-color-text)",
              background: entry.role === "user" ? "var(--vendo-color-background)" : "var(--vendo-color-surface)",
              borderInlineStart: `calc(var(--vendo-font-size) * 0.2) solid ${
                entry.role === "user" ? "var(--vendo-color-accent)" : "var(--vendo-color-border)"
              }`,
              borderRadius: "var(--vendo-radius-small)",
              padding: "calc(var(--vendo-font-size) * 0.5)",
            }}
          >
            <strong>{entry.role === "user" ? "You" : "Assistant"}: </strong>
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
      </section>
    </ChromeRoot>
  );
}
