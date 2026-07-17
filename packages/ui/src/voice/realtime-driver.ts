import { isPlainObject as isRecord } from "@vendoai/core";
import type {
  VoiceDriver,
  VoiceDriverEvent,
  VoiceSessionHandle,
  VoiceSessionState,
  VoiceTranscriptEntry,
} from "./driver.js";

export interface RealtimeVoiceDriverOptions {
  getSession(): Promise<{ clientSecret: string; model?: string }>;
  callsUrl?: string;
  instructions?: string;
}

export type RealtimeMappedEvent =
  | { type: "state"; state: VoiceSessionState }
  | { type: "transcript-delta"; id: string; role: VoiceTranscriptEntry["role"]; delta: string }
  | { type: "transcript-final"; id: string; role: VoiceTranscriptEntry["role"]; text: string }
  | { type: "error"; message: string };

const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/**
 * Maps provider data-channel payloads without touching browser globals. Keeping
 * this seam pure makes protocol growth deterministic and separately testable.
 */
export function mapRealtimeServerEvent(input: unknown): RealtimeMappedEvent[] {
  if (!isRecord(input) || typeof input.type !== "string") return [];
  const type = input.type;

  if (type === "input_audio_buffer.speech_started" || type === "input_audio_buffer.speech_stopped") {
    return [{ type: "state", state: "listening" }];
  }

  if (type.endsWith("input_audio_transcription.delta")) {
    return [{
      type: "transcript-delta",
      id: `user:${stringValue(input.item_id, "input")}`,
      role: "user",
      delta: stringValue(input.delta),
    }];
  }

  if (type.endsWith("input_audio_transcription.completed")) {
    return [{
      type: "transcript-final",
      id: `user:${stringValue(input.item_id, "input")}`,
      role: "user",
      text: stringValue(input.transcript),
    }];
  }

  if (type.startsWith("response.") && type.endsWith("audio_transcript.delta")) {
    return [
      { type: "state", state: "speaking" },
      {
        type: "transcript-delta",
        id: `assistant:${stringValue(input.response_id ?? input.item_id, "response")}`,
        role: "assistant",
        delta: stringValue(input.delta),
      },
    ];
  }

  if (type.startsWith("response.") && type.endsWith("audio_transcript.done")) {
    return [{
      type: "transcript-final",
      id: `assistant:${stringValue(input.response_id ?? input.item_id, "response")}`,
      role: "assistant",
      text: stringValue(input.transcript),
    }];
  }

  if (type === "response.done") return [{ type: "state", state: "listening" }];

  if (type === "error") {
    const error = isRecord(input.error) ? input.error : undefined;
    return [{ type: "error", message: stringValue(error?.message, "Realtime voice error") }];
  }

  return [];
}

/** OpenAI Realtime over WebRTC, using only an ephemeral browser credential. */
export function realtimeVoiceDriver(options: RealtimeVoiceDriverOptions): VoiceDriver {
  return {
    start(handlers): VoiceSessionHandle {
      let alive = true;
      let peer: RTCPeerConnection | null = null;
      let channel: RTCDataChannel | null = null;
      let microphone: MediaStream | null = null;
      let audio: HTMLAudioElement | null = null;
      const accumulated = new Map<string, string>();

      const emit = (event: VoiceDriverEvent) => {
        if (alive) handlers.onEvent(event);
      };

      const teardown = () => {
        if (!alive) return;
        alive = false;
        try {
          channel?.close();
        } catch {
          // The browser may already have closed the channel.
        }
        try {
          peer?.close();
        } catch {
          // The browser may already have closed the peer.
        }
        try {
          microphone?.getTracks().forEach((track) => track.stop());
        } catch {
          // A partially initialized stream may already be gone.
        }
        try {
          if (audio) {
            audio.srcObject = null;
            audio.remove();
          }
        } catch {
          // A host may have removed the element during teardown.
        }
      };

      const fail = (cause: unknown) => {
        if (!alive) return;
        const message = cause instanceof Error ? cause.message : "Voice session failed";
        emit({ type: "error", error: { message, cause } });
        teardown();
      };

      const acceptServerEvent = (raw: unknown) => {
        let parsed: unknown = raw;
        if (typeof raw === "string") {
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch {
            return;
          }
        }

        for (const event of mapRealtimeServerEvent(parsed)) {
          if (event.type === "state") {
            emit(event);
          } else if (event.type === "transcript-delta") {
            const text = (accumulated.get(event.id) ?? "") + event.delta;
            accumulated.set(event.id, text);
            emit({
              type: "transcript",
              entry: { id: event.id, role: event.role, text, final: false },
            });
          } else if (event.type === "transcript-final") {
            const text = event.text || accumulated.get(event.id) || "";
            accumulated.delete(event.id);
            emit({
              type: "transcript",
              entry: { id: event.id, role: event.role, text, final: true },
            });
          } else {
            fail(new Error(event.message));
          }
        }
      };

      const initialize = async () => {
        emit({ type: "state", state: "connecting" });
        try {
          const browser = browserCapabilities();
          const stream = await browser.mediaDevices.getUserMedia({ audio: true });
          if (!alive) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          microphone = stream;

          const session = await options.getSession();
          if (!session.clientSecret) throw new Error("Voice session did not provide a client secret");
          if (!alive) return;

          peer = new browser.PeerConnection();
          audio = browser.document.createElement("audio");
          audio.autoplay = true;
          audio.hidden = true;
          browser.document.body.appendChild(audio);

          peer.ontrack = (event) => {
            const remote = event.streams[0];
            if (audio && remote) {
              audio.srcObject = remote;
              void audio.play().catch((error: unknown) => fail(error));
            }
          };
          peer.onconnectionstatechange = () => {
            if (!alive || !peer) return;
            if (peer.connectionState === "disconnected") {
              emit({ type: "state", state: "connecting" });
            } else if (peer.connectionState === "failed") {
              fail(new Error("Voice connection failed"));
            }
          };

          for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

          channel = peer.createDataChannel("oai-events");
          channel.onmessage = (event) => acceptServerEvent(event.data);
          channel.onerror = () => fail(new Error("Voice data channel failed"));
          channel.onopen = () => {
            if (!channel || channel.readyState !== "open") return;
            if (options.instructions) {
              channel.send(JSON.stringify({
                type: "session.update",
                session: { type: "realtime", instructions: options.instructions },
              }));
            }
            emit({ type: "state", state: "listening" });
          };

          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          if (!offer.sdp) throw new Error("Voice connection offer was empty");

          const response = await browser.fetch(options.callsUrl ?? DEFAULT_CALLS_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.clientSecret}`,
              "Content-Type": "application/sdp",
            },
            body: offer.sdp,
          });
          if (!response.ok) throw new Error(`Voice SDP exchange failed (${response.status})`);
          if (!alive || !peer) return;
          await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
        } catch (error) {
          fail(error);
        }
      };

      void initialize();
      return { stop: teardown };
    },
  };
}

function browserCapabilities(): {
  mediaDevices: MediaDevices;
  PeerConnection: typeof RTCPeerConnection;
  document: Document;
  fetch: typeof fetch;
} {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new Error("Microphone capture is unavailable in this environment");
  }
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC is unavailable in this environment");
  }
  if (typeof document === "undefined") {
    throw new Error("Audio playback is unavailable in this environment");
  }
  if (typeof fetch !== "function") {
    throw new Error("SDP exchange is unavailable in this environment");
  }
  // `fetch` must keep `this === window`; called as `browser.fetch(...)` it would
  // throw "Illegal invocation". Bind it so the capability object is safe to call.
  return { mediaDevices: navigator.mediaDevices, PeerConnection: RTCPeerConnection, document, fetch: fetch.bind(globalThis) };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
