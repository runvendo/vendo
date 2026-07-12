import { ChromeRoot } from "../chrome/chrome-root.js";
import type { VoiceState } from "./driver.js";
import { useVoice } from "./use-voice.js";
import { VoiceBlob, type VoiceBlobState } from "./voice-blob.js";

const ACTIVE_STATES = new Set<VoiceState>(["connecting", "listening", "speaking"]);

/** The accessible, theme-adopting voice surface (08-ui §4). */
export function VendoStage() {
  const { state, start, stop, transcript } = useVoice();
  const active = ACTIVE_STATES.has(state);
  const blobState: VoiceBlobState =
    state === "unavailable"
      ? "muted"
      : state === "idle"
        ? "connecting"
        : state;

  return (
    <ChromeRoot>
      <section
        aria-label="Voice"
        className={`fl-voice-stage${state === "speaking" ? " is-speaking" : ""}`}
        data-state={state}
      >
        <div className={`fl-voice-canvas${transcript.length > 0 ? " has-views" : ""}`}>
          <div className="fl-voice-lift" aria-hidden="true" />
          <div className="fl-voice-head">
            <div className={`fl-voice-blob${state === "listening" ? " fl-approval-listening" : ""}`}>
              <VoiceBlob state={blobState} />
            </div>
            <div className="fl-voice-status" role="status" aria-live="polite">
              Voice: {state}
            </div>
            <ol
              className="fl-voice-caption"
              aria-label="Voice transcript"
              aria-live="polite"
              style={{ margin: 0, listStyle: "none" }}
            >
              {transcript.map((entry) => (
                <li key={entry.id} className="fl-voice-line" data-final={entry.final}>
                  <span className="fl-voice-line-role">{entry.role === "user" ? "You" : "Assistant"}</span>
                  <span className={entry.role === "user" ? "is-user" : "is-agent"}>{entry.text}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="fl-voice-lift" aria-hidden="true" />
        </div>

        <div className="fl-voice-foot">
          <div />
          <div className="fl-voice-controls">
            <button
              type="button"
              className="fl-btn fl-btn-primary"
              aria-pressed={active}
              disabled={state === "unavailable"}
              onClick={active ? stop : start}
            >
              {active ? "Stop voice" : "Start voice"}
            </button>
          </div>
        </div>
      </section>
    </ChromeRoot>
  );
}
